import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import { MantineProvider } from "@mantine/core";
import { DatesProvider } from "@mantine/dates";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./dates";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("root が見つかりません");
}

const liffId = import.meta.env.VITE_LIFF_ID ?? "";

createRoot(root).render(
  <StrictMode>
    <MantineProvider>
      <DatesProvider settings={{ locale: "ja" }}>
        <App liffId={liffId} />
      </DatesProvider>
    </MantineProvider>
  </StrictMode>,
);
