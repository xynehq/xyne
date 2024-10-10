import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { api } from "@/api";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    const res = await api.api.me.$get();
    if (!res.ok) {
      // If user is not logged in, take user to '/auth'
      throw redirect({ to: "/auth" });
    }
  },
  component: () => {
    return <Outlet />;
  },
});
