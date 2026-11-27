// @ts-check
/**
 * The chat's files, in a panel that slides in from the right: the person's and the model's, newest first, each
 * with who added it, its size and when, a Download link (always an attachment) and Delete (asked once, by the
 * app). The list is ChatFiles'; this only draws it.
 *
 * @typedef {import("../core/protocol.js").ChatFile} ChatFile
 */

import { el, icon } from "./dom.js";
import { text } from "./strings.js";

export class FilesPanel {
  /**
   * @param {{href: (file: ChatFile) => string, onDelete: (file: ChatFile) => void, onClose: () => void}} options
   */
  constructor({ href, onDelete, onClose }) {
    this.href = href;
    this.onDelete = onDelete;
    const close = el("button", { type: "button", class: "rail-toggle", "aria-label": text.closeFiles,
      title: text.closeFiles }, icon("close"));
    close.addEventListener("click", onClose);
    this.list = el("ul", { class: "files-list" });
    this.empty = el("p", { class: "files-empty" }, text.noFiles);
    this.element = el("aside", { class: "files-panel", id: "files-panel", "aria-labelledby": "files-title" },
      el("div", { class: "files-head" }, el("h2", { id: "files-title" }, text.files), close),
      this.empty, this.list);
  }

  /** @param {ChatFile[]} files */
  update(files) {
    this.empty.hidden = files.length > 0;
    this.list.replaceChildren(...files.map((file) => {
      const remove = el("button", { type: "button", class: "button button-small button-quiet",
        "aria-label": text.deleteFile(file.name) }, text.delete);
      remove.addEventListener("click", () => this.onDelete(file));
      return el("li", { class: "file-row", "data-id": file.id },
        el("div", { class: "file-row-text" },
          el("span", { class: "file-row-name" }, file.name),
          el("span", { class: "file-row-meta" },
            `${file.origin === "model" ? text.byModel : text.byYou} · ${text.size(file.size)} · ${text.when(file.created_at)}`)),
        el("div", { class: "file-row-actions" },
          el("a", { class: "button button-small", href: this.href(file), download: "",
            "aria-label": text.downloadFile(file.name) }, text.download),
          remove));
    }));
  }
}
