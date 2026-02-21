/*
 * commands.ts — Ribbon button handler.
 *
 * This file is the entry point for Office Add-in ribbon commands.
 * It runs in a separate (headless) commands context, not in the task pane.
 */

Office.onReady(() => {
  // Register any ribbon button actions here
});

/**
 * Opens the Usable Chat task pane when the ribbon button is clicked.
 */
function openTaskPane(event: Office.AddinCommands.Event): void {
  Office.addin.showAsTaskpane();
  event.completed();
}

// Expose to Office runtime
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any)["openTaskPane"] = openTaskPane;
