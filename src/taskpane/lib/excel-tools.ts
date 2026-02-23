/**
 * Excel parent tools — schemas and Office.js handler implementations.
 *
 * Each tool:
 *  1. Has a `schema` (ParentToolSchema) that is registered with the Usable embed.
 *  2. Has a `handler` that executes the Office.js operation and returns a plain object.
 *
 * All handlers wrap operations in Excel.run() and call context.sync().
 * Read operations use .load() before sync and read values after.
 * Large writes are chunked in ≤10-row batches to avoid Office API timeouts.
 */

import { ParentToolSchema } from "./embed-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExcelToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface ExcelTool {
  schema: ParentToolSchema;
  handler: ExcelToolHandler;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSheet(context: Excel.RequestContext, sheetName?: string): Excel.Worksheet {
  return sheetName
    ? context.workbook.worksheets.getItem(sheetName as string)
    : context.workbook.worksheets.getActiveWorksheet();
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const tools: ExcelTool[] = [
  // ─── Workbook / Sheet Info ────────────────────────────────────────────────

  {
    schema: {
      name: "get_workbook_info",
      description:
        "Get high-level information about the current Excel workbook: its name, active sheet, and a full list of all worksheets with their names, IDs, and positions.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    handler: async () => {
      return Excel.run(async (context) => {
        const workbook = context.workbook;
        const sheets = workbook.worksheets;
        const active = sheets.getActiveWorksheet();

        workbook.load("name");
        sheets.load("items/name,items/id,items/position");
        active.load("name");

        await context.sync();

        return {
          workbookName: workbook.name,
          activeSheet: active.name,
          sheets: sheets.items.map((s) => ({
            name: s.name,
            id: s.id,
            position: s.position,
          })),
        };
      });
    },
  },

  {
    schema: {
      name: "get_active_sheet",
      description:
        "Get the name and used-range data (values) of the currently active worksheet.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    handler: async () => {
      return Excel.run(async (context) => {
        const sheet = context.workbook.worksheets.getActiveWorksheet();
        sheet.load("name");

        const usedRange = sheet.getUsedRangeOrNullObject();
        usedRange.load("address,values,rowCount,columnCount");

        await context.sync();

        if (usedRange.isNullObject) {
          return { sheetName: sheet.name, isEmpty: true, values: [] };
        }

        return {
          sheetName: sheet.name,
          address: usedRange.address,
          rowCount: usedRange.rowCount,
          columnCount: usedRange.columnCount,
          values: usedRange.values,
        };
      });
    },
  },

  // ─── Read ─────────────────────────────────────────────────────────────────

  {
    schema: {
      name: "read_range",
      description: "Read the values from a specific cell range (e.g. 'A1:C10') on a worksheet.",
      parameters: {
        type: "object",
        properties: {
          sheet: {
            type: "string",
            description: "Sheet name. Defaults to the active sheet if omitted.",
          },
          address: {
            type: "string",
            description: "Cell address or range, e.g. 'A1', 'A1:D10'.",
          },
        },
        required: ["address"],
      },
    },
    handler: async (args) => {
      return Excel.run(async (context) => {
        const sheet = getSheet(context, args.sheet as string | undefined);
        const range = sheet.getRange(args.address as string);
        range.load("address,values,rowCount,columnCount");
        await context.sync();

        return {
          address: range.address,
          rowCount: range.rowCount,
          columnCount: range.columnCount,
          values: range.values,
        };
      });
    },
  },

  {
    schema: {
      name: "read_selected_range",
      description:
        "Read the values from whatever range the user currently has selected in Excel.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    handler: async () => {
      return Excel.run(async (context) => {
        const range = context.workbook.getSelectedRange();
        range.load("address,values,rowCount,columnCount");
        await context.sync();

        return {
          address: range.address,
          rowCount: range.rowCount,
          columnCount: range.columnCount,
          values: range.values,
        };
      });
    },
  },

  {
    schema: {
      name: "get_used_range",
      description: "Get all values from the used (non-empty) range of a worksheet.",
      parameters: {
        type: "object",
        properties: {
          sheet: {
            type: "string",
            description: "Sheet name. Defaults to the active sheet if omitted.",
          },
        },
      },
    },
    handler: async (args) => {
      return Excel.run(async (context) => {
        const sheet = getSheet(context, args.sheet as string | undefined);
        const usedRange = sheet.getUsedRangeOrNullObject();
        usedRange.load("address,values,rowCount,columnCount");
        await context.sync();

        if (usedRange.isNullObject) {
          return { isEmpty: true, values: [] };
        }

        return {
          address: usedRange.address,
          rowCount: usedRange.rowCount,
          columnCount: usedRange.columnCount,
          values: usedRange.values,
        };
      });
    },
  },

  // ─── Write ────────────────────────────────────────────────────────────────

  {
    schema: {
      name: "write_range",
      description:
        "Write a 2-D array of values into a cell range. The values array dimensions must match the address range. Large writes are automatically chunked.",
      parameters: {
        type: "object",
        properties: {
          sheet: {
            type: "string",
            description: "Sheet name. Defaults to the active sheet if omitted.",
          },
          address: {
            type: "string",
            description: "Top-left cell or full range address, e.g. 'A1' or 'A1:C3'.",
          },
          values: {
            type: "array",
            description: "2-D array of values (rows × columns) to write.",
          },
        },
        required: ["address", "values"],
      },
    },
    handler: async (args) => {
      const values = args.values as unknown[][];
      const rowChunks = chunk(values, 10);
      let startRow = 0;

      await Excel.run(async (context) => {
        const sheet = getSheet(context, args.sheet as string | undefined);
        // Determine top-left cell from address
        const topLeft = (args.address as string).split(":")[0];

        for (const rowChunk of rowChunks) {
          // Compute the offset address for this chunk
          const chunkAddress = `${topLeft}`;
          const range = sheet.getRange(chunkAddress).getCell(startRow, 0)
            .getResizedRange(rowChunk.length - 1, rowChunk[0].length - 1);
          range.values = rowChunk as string[][];
          await context.sync();
          startRow += rowChunk.length;
        }
      });

      return { success: true, rowsWritten: values.length };
    },
  },

  {
    schema: {
      name: "set_cell_value",
      description: "Write a single value into one cell.",
      parameters: {
        type: "object",
        properties: {
          sheet: {
            type: "string",
            description: "Sheet name. Defaults to the active sheet if omitted.",
          },
          address: {
            type: "string",
            description: "Cell address, e.g. 'A1'.",
          },
          value: {
            description: "Value to write (string, number, or boolean).",
          },
        },
        required: ["address", "value"],
      },
    },
    handler: async (args) => {
      return Excel.run(async (context) => {
        const sheet = getSheet(context, args.sheet as string | undefined);
        const cell = sheet.getRange(args.address as string);
        cell.values = [[args.value]];
        await context.sync();
        return { success: true };
      });
    },
  },

  {
    schema: {
      name: "clear_range",
      description: "Clear the contents (and optionally formatting) of a cell range.",
      parameters: {
        type: "object",
        properties: {
          sheet: {
            type: "string",
            description: "Sheet name. Defaults to the active sheet if omitted.",
          },
          address: {
            type: "string",
            description: "Cell range to clear, e.g. 'A1:C10'.",
          },
          clearType: {
            type: "string",
            enum: ["all", "contents", "formats", "hyperlinks"],
            description: "What to clear. Defaults to 'contents'.",
          },
        },
        required: ["address"],
      },
    },
    handler: async (args) => {
      return Excel.run(async (context) => {
        const sheet = getSheet(context, args.sheet as string | undefined);
        const range = sheet.getRange(args.address as string);
        const clearType = (args.clearType as Excel.ClearApplyTo) ?? Excel.ClearApplyTo.contents;
        range.clear(clearType);
        await context.sync();
        return { success: true };
      });
    },
  },

  // ─── Formulas ─────────────────────────────────────────────────────────────

  {
    schema: {
      name: "apply_formula",
      description: "Apply an Excel formula to one or more cells.",
      parameters: {
        type: "object",
        properties: {
          sheet: {
            type: "string",
            description: "Sheet name. Defaults to the active sheet if omitted.",
          },
          address: {
            type: "string",
            description: "Cell or range address.",
          },
          formula: {
            type: "string",
            description: "Excel formula string, e.g. '=SUM(A1:A10)'.",
          },
        },
        required: ["address", "formula"],
      },
    },
    handler: async (args) => {
      return Excel.run(async (context) => {
        const sheet = getSheet(context, args.sheet as string | undefined);
        const range = sheet.getRange(args.address as string);
        range.formulas = [[args.formula as string]];
        await context.sync();
        return { success: true };
      });
    },
  },

  // ─── Formatting ───────────────────────────────────────────────────────────

  {
    schema: {
      name: "format_range",
      description: "Apply formatting to a cell range: bold, italic, fill color, font color, number format.",
      parameters: {
        type: "object",
        properties: {
          sheet: {
            type: "string",
            description: "Sheet name. Defaults to the active sheet if omitted.",
          },
          address: {
            type: "string",
            description: "Cell range to format.",
          },
          bold: { type: "boolean" },
          italic: { type: "boolean" },
          fillColor: {
            type: "string",
            description: "HTML color string, e.g. '#FF0000' or 'red'.",
          },
          fontColor: {
            type: "string",
            description: "HTML color string for text.",
          },
          numberFormat: {
            type: "string",
            description: "Excel number format string, e.g. '0.00' or 'mm/dd/yyyy'.",
          },
        },
        required: ["address"],
      },
    },
    handler: async (args) => {
      return Excel.run(async (context) => {
        const sheet = getSheet(context, args.sheet as string | undefined);
        const range = sheet.getRange(args.address as string);
        const fmt = range.format;

        if (args.bold !== undefined) fmt.font.bold = args.bold as boolean;
        if (args.italic !== undefined) fmt.font.italic = args.italic as boolean;
        if (args.fillColor) fmt.fill.color = args.fillColor as string;
        if (args.fontColor) fmt.font.color = args.fontColor as string;
        if (args.numberFormat) range.numberFormat = [[args.numberFormat as string]];

        await context.sync();
        return { success: true };
      });
    },
  },

  {
    schema: {
      name: "autofit_columns",
      description: "Auto-fit column widths for the given range (or the whole used range if omitted).",
      parameters: {
        type: "object",
        properties: {
          sheet: {
            type: "string",
            description: "Sheet name. Defaults to the active sheet if omitted.",
          },
          address: {
            type: "string",
            description: "Range whose columns to auto-fit. If omitted, auto-fits the full used range.",
          },
        },
      },
    },
    handler: async (args) => {
      return Excel.run(async (context) => {
        const sheet = getSheet(context, args.sheet as string | undefined);
        const range = args.address
          ? sheet.getRange(args.address as string)
          : sheet.getUsedRange();
        range.format.autofitColumns();
        await context.sync();
        return { success: true };
      });
    },
  },

  // ─── Sheet Management ─────────────────────────────────────────────────────

  {
    schema: {
      name: "create_sheet",
      description: "Add a new worksheet with the given name.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name for the new worksheet.",
          },
        },
        required: ["name"],
      },
    },
    handler: async (args) => {
      return Excel.run(async (context) => {
        const sheet = context.workbook.worksheets.add(args.name as string);
        sheet.load("name,id,position");
        await context.sync();
        return { name: sheet.name, id: sheet.id, position: sheet.position };
      });
    },
  },

  {
    schema: {
      name: "rename_sheet",
      description: "Rename an existing worksheet.",
      parameters: {
        type: "object",
        properties: {
          oldName: { type: "string", description: "Current name of the worksheet." },
          newName: { type: "string", description: "New name for the worksheet." },
        },
        required: ["oldName", "newName"],
      },
    },
    handler: async (args) => {
      return Excel.run(async (context) => {
        const sheet = context.workbook.worksheets.getItem(args.oldName as string);
        sheet.name = args.newName as string;
        await context.sync();
        return { success: true };
      });
    },
  },

  {
    schema: {
      name: "delete_sheet",
      description: "Delete a worksheet by name. This is permanent.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the worksheet to delete." },
        },
        required: ["name"],
      },
    },
    handler: async (args) => {
      return Excel.run(async (context) => {
        const sheet = context.workbook.worksheets.getItem(args.name as string);
        sheet.delete();
        await context.sync();
        return { success: true };
      });
    },
  },

  {
    schema: {
      name: "activate_sheet",
      description: "Make a worksheet the active (selected) sheet.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the worksheet to activate." },
        },
        required: ["name"],
      },
    },
    handler: async (args) => {
      return Excel.run(async (context) => {
        const sheet = context.workbook.worksheets.getItem(args.name as string);
        sheet.activate();
        await context.sync();
        return { success: true };
      });
    },
  },

  // ─── Rows ─────────────────────────────────────────────────────────────────

  {
    schema: {
      name: "manage_rows",
      description: "Insert or delete rows at a given position. Use action='insert' to add blank rows above the row index, or action='delete' to remove rows starting at the row index.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["insert", "delete"],
            description: "'insert' adds blank rows above rowIndex; 'delete' removes rows starting at rowIndex.",
          },
          sheet: { type: "string", description: "Sheet name. Defaults to the active sheet." },
          rowIndex: { type: "number", description: "0-based row index to insert before or delete from." },
          count: { type: "number", description: "Number of rows to insert or delete." },
        },
        required: ["action", "rowIndex", "count"],
      },
    },
    handler: async (args) => {
      return Excel.run(async (context) => {
        const sheet = getSheet(context, args.sheet as string | undefined);
        const range = sheet.getRangeByIndexes(args.rowIndex as number, 0, args.count as number, 1);
        if (args.action === "insert") {
          range.insert(Excel.InsertShiftDirection.down);
        } else {
          range.delete(Excel.DeleteShiftDirection.up);
        }
        await context.sync();
        return { success: true };
      });
    },
  },

  // ─── Tables ───────────────────────────────────────────────────────────────

  {
    schema: {
      name: "create_table",
      description: "Convert a range into an Excel Table (ListObject).",
      parameters: {
        type: "object",
        properties: {
          sheet: { type: "string", description: "Sheet name. Defaults to the active sheet." },
          address: { type: "string", description: "Range address for the table, e.g. 'A1:D10'." },
          hasHeaders: {
            type: "boolean",
            description: "Whether the first row of the range contains headers. Defaults to true.",
          },
        },
        required: ["address"],
      },
    },
    handler: async (args) => {
      return Excel.run(async (context) => {
        const sheet = getSheet(context, args.sheet as string | undefined);
        const hasHeaders = args.hasHeaders !== false;
        const table = sheet.tables.add(args.address as string, hasHeaders);
        table.load("name,id");
        await context.sync();
        return { name: table.name, id: table.id };
      });
    },
  },

  // ─── Sort ─────────────────────────────────────────────────────────────────

  {
    schema: {
      name: "sort_range",
      description: "Sort a range of cells by a specific column.",
      parameters: {
        type: "object",
        properties: {
          sheet: { type: "string", description: "Sheet name. Defaults to the active sheet." },
          address: { type: "string", description: "Range to sort, e.g. 'A1:D100'." },
          columnIndex: {
            type: "number",
            description: "0-based column index within the range to sort by.",
          },
          ascending: {
            type: "boolean",
            description: "Sort ascending if true, descending if false. Defaults to true.",
          },
        },
        required: ["address", "columnIndex"],
      },
    },
    handler: async (args) => {
      return Excel.run(async (context) => {
        const sheet = getSheet(context, args.sheet as string | undefined);
        const range = sheet.getRange(args.address as string);
        const ascending = args.ascending !== false;
        range.sort.apply([
          {
            key: args.columnIndex as number,
            ascending,
          },
        ]);
        await context.sync();
        return { success: true };
      });
    },
  },

  // ─── Charts ───────────────────────────────────────────────────────────────

  {
    schema: {
      name: "add_chart",
      description: "Create a chart from a data range on the worksheet.",
      parameters: {
        type: "object",
        properties: {
          sheet: { type: "string", description: "Sheet name. Defaults to the active sheet." },
          dataAddress: {
            type: "string",
            description: "Range containing the chart data, e.g. 'A1:B10'.",
          },
          chartType: {
            type: "string",
            description:
              "Chart type. Supported: 'ColumnClustered', 'BarClustered', 'Line', 'Pie', 'Area', 'XYScatter'. Defaults to 'ColumnClustered'.",
          },
        },
        required: ["dataAddress"],
      },
    },
    handler: async (args) => {
      return Excel.run(async (context) => {
        const sheet = getSheet(context, args.sheet as string | undefined);
        const dataRange = sheet.getRange(args.dataAddress as string);
        const chartTypeName = (args.chartType as string) ?? "ColumnClustered";
        const chartType =
          (Excel.ChartType as Record<string, Excel.ChartType>)[chartTypeName] ??
          Excel.ChartType.columnClustered;

        sheet.charts.add(chartType, dataRange, Excel.ChartSeriesBy.auto);
        await context.sync();
        return { success: true, chartType: chartTypeName, dataAddress: args.dataAddress as string };
      });
    },
  },
];

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const excelToolSchemas: ParentToolSchema[] = tools.map((t) => t.schema);

const handlerMap: Map<string, ExcelToolHandler> = new Map(
  tools.map((t) => [t.schema.name, t.handler])
);

// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────────────
// In this environment (Office.js task pane on macOS / WKWebView + React legacy
// mode), two `window.addEventListener("message", ...)` listeners can become
// active simultaneously for a single UsableChatEmbed instance. This is caused
// by a combination of:
//
//   1. React legacy mode (ReactDOM.render) does not batch async state updates.
//      The two setState calls in useAuth's refreshAccessToken fire as separate
//      renders, which can briefly double-mount ChatPane and leave an orphaned
//      listener from the first mount.
//
//   2. Office.js / WKWebView has known quirks where the task pane JS context
//      can initialise in ways that React's effect cleanup does not fully
//      intercept.
//
// The result: a single TOOL_CALL postMessage is received by both listeners,
// causing handleExcelToolCall — and therefore Excel.run() — to execute twice.
// Non-idempotent operations like add_chart produce duplicate artefacts;
// others silently double-write or fail on the second attempt.
//
// FIX: track in-flight calls by (toolName + serialised args). If an identical
// call arrives while one is already running, return the same promise so
// Excel.run() only executes once. The second TOOL_RESPONSE is harmless.
const inFlightCalls = new Map<string, Promise<unknown>>();

export async function handleExcelToolCall(
  toolName: string,
  args: unknown
): Promise<unknown> {
  const handler = handlerMap.get(toolName);
  if (!handler) {
    throw new Error(`Unknown Excel tool: "${toolName}"`);
  }

  const key = `${toolName}:${JSON.stringify(args)}`;
  const existing = inFlightCalls.get(key);
  if (existing) return existing;

  const promise = handler(args as Record<string, unknown>).then(
    (result) => { inFlightCalls.delete(key); return result; },
    (err)    => { inFlightCalls.delete(key); throw err; }
  );
  inFlightCalls.set(key, promise);
  return promise;
}
