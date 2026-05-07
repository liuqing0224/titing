import { useMemo } from "react";
import { opsConsoleWebPlugin } from "../../../plugins/ops-console/web/src/plugin.manifest";

export default function App() {
  const activeRoute = useMemo(() => opsConsoleWebPlugin.routes[0], []);
  const Component = activeRoute.component;

  return <Component />;
}
