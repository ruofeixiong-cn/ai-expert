#!/usr/bin/env node
/**
 * public/openapi.json → public/zod.ts（见 docs/adr/007）
 *
 * 为什么要这一步：`make contract` 原来只生成 TS 类型，`min(1)`、`max(200)`
 * 这些约束前端拿不到 —— 于是前端只能【手抄】一份，抄漏了类型检查也全过，
 * 运行时必然 400（F03 就是这么来的）。约束和类型必须同源。
 *
 * 刻意不用现成的 openapi→zod 库：这份 spec 的构造面很窄（见下面的 SUPPORTED），
 * 自己生成能保证【遇到不认识的构造就报错】，而不是悄悄降级成 z.any() ——
 * 那等于把"契约即编译期检查"又变回"靠人记得"。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = resolve(root, "contracts/public/openapi.json");
const OUT = resolve(root, "contracts/public/zod.ts");

/** 认识的关键字。出现别的就抛错 —— 宁可让生成失败，也不要悄悄少一条约束。 */
const SUPPORTED = new Set([
  "type", "properties", "required", "items", "enum", "$ref",
  "allOf", "oneOf", "anyOf", "format", "default",
  "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems",
  // 纯文档性质，不影响校验
  "description", "example", "examples", "title", "deprecated", "readOnly", "writeOnly",
]);

const FORMATS = {
  uuid: ".uuid()",
  email: ".email()",
  "date-time": ".datetime()",
  uri: ".url()",
};

const q = (s) => JSON.stringify(s);

/** zod 的版本必须和 backend 一致：同一个 min(1) 在两边得是同一个意思。 */
function checkZodVersion() {
  const range = (p) => {
    const pkg = JSON.parse(readFileSync(resolve(root, p), "utf8"));
    return pkg.dependencies?.zod ?? pkg.devDependencies?.zod;
  };
  const major = (r) => r?.match(/(\d+)\./)?.[1];
  const here = range("package.json");
  const backend = range("backend/package.json");
  if (!here || !backend) throw new Error("找不到 zod 依赖声明（根 / backend）");
  if (major(here) !== major(backend)) {
    throw new Error(
      `zod 大版本不一致：根 ${here} vs backend ${backend}。` +
        "生成的约束要和后端校验行为一致，两边必须一起升（ADR-007）。",
    );
  }
}

function refName(ref, at) {
  const m = /^#\/components\/schemas\/(\w+)$/.exec(ref);
  if (!m) throw new Error(`${at}: 只支持引用 components.schemas，收到 ${ref}`);
  return m[1];
}

/** 全部组件，供 hasDefault 跟着 $ref 查。main() 里赋值。 */
let ALL = {};

/** 这个字段（可能是个 $ref）最终有没有默认值。 */
function hasDefault(sub) {
  if (!sub || typeof sub !== "object") return false;
  if ("default" in sub) return true;
  if (typeof sub.$ref === "string") return hasDefault(ALL[refName(sub.$ref, "hasDefault")]);
  return false;
}

function convert(schema, at) {
  if (typeof schema !== "object" || schema === null) throw new Error(`${at}: 不是一个 schema`);

  for (const k of Object.keys(schema)) {
    if (!SUPPORTED.has(k)) throw new Error(`${at}: 不认识的关键字 ${k} —— 请在生成器里显式支持它`);
  }

  if (schema.$ref) return refName(schema.$ref, at);

  // 组合
  if (schema.allOf) {
    // 交集：ExpertDetail = Expert + 几个附加字段
    return schema.allOf.map((s, i) => convert(s, `${at}.allOf[${i}]`)).reduce((a, b) => `${a}.and(${b})`);
  }
  const union = schema.oneOf ?? schema.anyOf;
  if (union) {
    const key = schema.oneOf ? "oneOf" : "anyOf";
    return `z.union([${union.map((s, i) => convert(s, `${at}.${key}[${i}]`)).join(", ")}])`;
  }

  // 可空：zod-openapi 把 .nullable() 输出成 type: ["x", "null"]
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const nullable = types.includes("null");
  const real = types.filter((t) => t !== "null");
  if (real.length > 1) throw new Error(`${at}: 不支持多类型 ${JSON.stringify(schema.type)}`);
  const type = real[0];

  // 纯 null（统一响应体里 data 为 null 的那一类）
  if (real.length === 0 && nullable) return "z.null()";

  let out;
  if (schema.enum) {
    const values = schema.enum;
    if (!values.every((v) => typeof v === "string")) throw new Error(`${at}: 只支持字符串 enum`);
    out = values.length === 1 ? `z.literal(${q(values[0])})` : `z.enum([${values.map(q).join(", ")}])`;
  } else if (type === "object") {
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(props).map(([name, sub]) => {
      let expr = convert(sub, `${at}.${name}`);
      // 有 default 的字段在输入侧可以省略，zod 的 .default() 已经隐含 optional。
      // 再套一层 .optional() 会【盖掉】default：解析 undefined 得到 undefined 而不是默认值，
      // 和后端行为就不一致了。default 可能写在被 $ref 的组件上（ItemOrigin 就是），所以要跟过去看。
      if (!required.has(name) && !hasDefault(sub)) expr += ".optional()";
      return `  ${/^[A-Za-z_$][\w$]*$/.test(name) ? name : q(name)}: ${expr},`;
    });
    out = fields.length ? `z.object({\n${fields.join("\n")}\n})` : "z.object({})";
  } else if (type === "array") {
    if (!schema.items) throw new Error(`${at}: array 缺 items`);
    out = `z.array(${convert(schema.items, `${at}[]`)})`;
    if (schema.minItems !== undefined) out += `.min(${schema.minItems})`;
    if (schema.maxItems !== undefined) out += `.max(${schema.maxItems})`;
  } else if (type === "string") {
    out = "z.string()";
    if (schema.format) {
      const f = FORMATS[schema.format];
      if (!f) throw new Error(`${at}: 不认识的 format ${schema.format}`);
      out += f;
    }
    if (schema.minLength !== undefined) out += `.min(${schema.minLength})`;
    if (schema.maxLength !== undefined) out += `.max(${schema.maxLength})`;
  } else if (type === "integer" || type === "number") {
    out = "z.number()";
    if (type === "integer") out += ".int()";
    if (schema.minimum !== undefined) out += `.min(${schema.minimum})`;
    if (schema.maximum !== undefined) out += `.max(${schema.maximum})`;
  } else if (type === "boolean") {
    out = "z.boolean()";
  } else if (type === undefined) {
    throw new Error(`${at}: 没有 type，也不是 $ref / 组合 —— 生成器不猜`);
  } else {
    throw new Error(`${at}: 不支持的 type ${type}`);
  }

  if (nullable) out += ".nullable()";
  if ("default" in schema) out += `.default(${JSON.stringify(schema.default)})`;
  return out;
}

/** 按 $ref 依赖排序：被引用的先声明。有环就报错（当前 spec 没有环）。 */
function order(schemas) {
  const deps = (node, acc = new Set()) => {
    if (Array.isArray(node)) node.forEach((n) => deps(n, acc));
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "$ref" && typeof v === "string") acc.add(refName(v, "order"));
        else deps(v, acc);
      }
    }
    return acc;
  };
  const pending = new Map(Object.entries(schemas).map(([n, s]) => [n, deps(s)]));
  const done = [];
  const seen = new Set();
  while (pending.size) {
    const ready = [...pending].filter(([, d]) => [...d].every((x) => seen.has(x))).map(([n]) => n);
    if (!ready.length) throw new Error(`存在循环引用：${[...pending.keys()].join(", ")}`);
    for (const n of ready.sort()) {
      done.push(n);
      seen.add(n);
      pending.delete(n);
    }
  }
  return done;
}

function main() {
  checkZodVersion();
  const spec = JSON.parse(readFileSync(SPEC, "utf8"));
  const schemas = spec.components?.schemas ?? {};
  ALL = schemas;

  const body = order(schemas)
    .map((name) => {
      const desc = schemas[name].description;
      const comment = desc ? `/** ${desc.replace(/\s*\n\s*/g, " ")} */\n` : "";
      return `${comment}export const ${name} = ${convert(schemas[name], name)};\n`;
    })
    .join("\n");

  writeFileSync(
    OUT,
    `// 由 \`make contract\` 从 contracts/public/openapi.json 生成 —— 禁止手写。\n` +
      `//\n` +
      `// 这里只有【运行期约束】（长度、范围、枚举、必填）。类型仍然从 api.d.ts 取，\n` +
      `// 不要从这里 z.infer —— 一份契约两个类型来源，迟早对不上。\n` +
      `//\n` +
      `// 表达不进 JSON Schema 的条件约束（比如 ExampleItem 按 origin 分叉的证据规则）\n` +
      `// 不在这里，由服务端兜底，前端要写就近的显式判断（见 ADR-003 / ADR-007）。\n` +
      `\n` +
      `import { z } from "zod";\n\n${body}`,
    "utf8",
  );
  console.log(`✓ ${OUT.replace(root + "/", "")}（${Object.keys(schemas).length} 个组件）`);
}

main();
