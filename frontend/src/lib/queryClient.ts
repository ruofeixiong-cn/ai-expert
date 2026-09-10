import { QueryClient } from "@tanstack/react-query";
import { getAccessToken, subscribe } from "./auth";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,            // 401 已由 api client 自动刷新重试，这里不必再叠
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * 登录态一丢（登出、刷新失败、会话被吊销）就清空全部缓存（F06）。
 *
 * QueryClient 是全局单例，缓存不会跟着 token 一起消失。不清的话，同一台电脑上
 * 换一个账号登录，专家列表在 staleTime 内直接显示上一个账号的数据。
 * 数据库那一层的隔离没问题 —— 漏的是浏览器里这一层。
 *
 * 只在「变成未登录」时清，不在每次换 token 时清：同一会话里 15 分钟一次的
 * 刷新也会换 token，那时清缓存只会让页面白白闪一下。
 */
subscribe(() => {
  if (getAccessToken() === null) queryClient.clear();
});
