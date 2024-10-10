import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/oauth/success")({
  component: () => {
    if (window.opener && !window.opener.closed) {
      window.close();
    } else {
      // not in a popup
    }
    return <></>;
  },
});
