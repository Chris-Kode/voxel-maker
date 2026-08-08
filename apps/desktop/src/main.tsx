import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./app.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing #root element in index.html");
}
createRoot(root).render(<App />);
