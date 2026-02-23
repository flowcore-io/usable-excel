import * as React from "react";
import * as ReactDOM from "react-dom";
import { App } from "./App";

// Office.js must be initialized before rendering.
// Office.onReady() fires when the Office host is ready to receive API calls.
Office.onReady((_info) => {
  ReactDOM.render(
    <App />,
    document.getElementById("container")
  );
});
