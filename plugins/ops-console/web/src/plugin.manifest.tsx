import { ComponentType } from "react";
import App from "./App";

export type WebPluginRoute = {
  path: string;
  label: string;
  component: ComponentType;
};

export const opsConsoleWebPlugin = {
  id: "ops-console",
  routes: [
    {
      path: "/",
      label: "Ops Console",
      component: App
    }
  ]
};
