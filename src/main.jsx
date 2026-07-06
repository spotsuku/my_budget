import React from "react";
import { createRoot } from "react-dom/client";
import CashflowDashboard from "./CashflowDashboard.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <CashflowDashboard />
  </React.StrictMode>
);
