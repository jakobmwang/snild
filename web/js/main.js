// @ts-check
import { applyTheme, savedTheme } from "./ui/theme.js";
import { start } from "./ui/app.js";

applyTheme(savedTheme()); // before anything is drawn
start(/** @type {HTMLElement} */ (document.getElementById("app")));
