// Tool schemas ported from open-claude-in-chrome's host/tool-definitions.js
// (MIT). Each entry is { name, description, paramShape } where paramShape is
// the object literal of zod values passed to the MCP server's tool()
// registration. These are the browser-control tools currently exposed by the
// MCP server; the extension-runtime background.js implements them.

import { z } from "zod";

export interface ToolDefinition {
  name: string;
  description: string;
  paramShape: Record<string, z.ZodTypeAny>;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "tabs_context_mcp",
    description:
      "Get context about the browser tabs. Returns the agent's MCP tab group tabs (marked group: \"agent\") AND the user's open tabs (marked group: \"user\"), with tab IDs. You can act on any of them. CRITICAL: You must get the context at least once before using other browser automation tools so you know what tabs exist. Prefer creating your own new tab (tabs_create_mcp) for automation, but you may act on the user's existing tabs when the user asks you to work in their current browsing session.",
    paramShape: {
      createIfEmpty: z
        .boolean()
        .optional()
        .describe(
          "Creates a new MCP tab group if none exists, creates a new Window with a new tab group containing an empty tab (which can be used for this conversation). If a MCP tab group already exists, this parameter has no effect."
        ),
    },
  },
  {
    name: "tabs_create_mcp",
    description:
      "Creates a new empty tab in the MCP tab group. CRITICAL: You must get the context using tabs_context_mcp at least once before using other browser automation tools so you know what tabs exist.",
    paramShape: {},
  },
  {
    name: "tabs_close_mcp",
    description:
      "Close one or more tabs in the MCP tab group. The tab is actually removed from the browser — this is the only correct way to close a tab. Do NOT use navigate to 'about:blank' to 'close' a tab; that just navigates the tab to a blank page and leaves it open. Only tabs in the current MCP group can be closed; requests for tabs outside the group are skipped. If you close the last remaining tab, the MCP group window closes and you'll need tabs_context_mcp({ createIfEmpty: true }) to start a new group.",
    paramShape: {
      tabId: z
        .number()
        .optional()
        .describe(
          "Single tab ID to close. Must be a tab in the current MCP group. Use tabs_context_mcp if you don't have a valid tab ID."
        ),
      tabIds: z
        .array(z.number())
        .optional()
        .describe(
          "Optional batch form: an array of tab IDs to close in one call. Use either `tabId` or `tabIds`, not both."
        ),
    },
  },
  {
    name: "navigate",
    description:
      "Navigate to a URL, or go forward/back in browser history. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      url: z
        .string()
        .describe(
          'The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.'
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID to navigate. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
    },
  },
  {
    name: "computer",
    description:
      "Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.\n* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
    paramShape: {
      action: z
        .enum([
          "left_click",
          "right_click",
          "double_click",
          "triple_click",
          "type",
          "screenshot",
          "wait",
          "scroll",
          "key",
          "left_click_drag",
          "zoom",
          "scroll_to",
          "hover",
        ])
        .describe(
          "The action to perform:\n* `left_click`: Click the left mouse button at the specified coordinates.\n* `right_click`: Click the right mouse button at the specified coordinates to open context menus.\n* `double_click`: Double-click the left mouse button at the specified coordinates.\n* `triple_click`: Triple-click the left mouse button at the specified coordinates.\n* `type`: Type a string of text.\n* `screenshot`: Take a screenshot of the screen.\n* `wait`: Wait for a specified number of seconds.\n* `scroll`: Scroll up, down, left, or right at the specified coordinates.\n* `key`: Press a specific keyboard key.\n* `left_click_drag`: Drag from start_coordinate to coordinate.\n* `zoom`: Take a screenshot of a specific region for closer inspection.\n* `scroll_to`: Scroll an element into view using its element reference ID from read_page or find tools.\n* `hover`: Move the mouse cursor to the specified coordinates or element without clicking. Useful for revealing tooltips, dropdown menus, or triggering hover states."
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID to execute the action on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
      coordinate: z
        .array(z.number())
        .min(2)
        .max(2)
        .optional()
        .describe(
          "(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for `left_click`, `right_click`, `double_click`, `triple_click`, and `scroll`. For `left_click_drag`, this is the end position."
        ),
      duration: z
        .number()
        .min(0)
        .max(30)
        .optional()
        .describe("The number of seconds to wait. Required for `wait`. Maximum 30 seconds."),
      modifiers: z
        .string()
        .optional()
        .describe(
          'Modifier keys for click actions. Supports: "ctrl", "shift", "alt", "cmd" (or "meta"), "win" (or "windows"). Can be combined with "+" (e.g., "ctrl+shift", "cmd+alt"). Optional.'
        ),
      ref: z
        .string()
        .optional()
        .describe(
          'Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Required for `scroll_to` action. Can be used as alternative to `coordinate` for click actions.'
        ),
      region: z
        .array(z.number())
        .min(4)
        .max(4)
        .optional()
        .describe(
          "(x0, y0, x1, y1): The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom` action. Useful for inspecting small UI elements like icons, buttons, or text."
        ),
      repeat: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "Number of times to repeat the key sequence. Only applicable for `key` action. Must be a positive integer between 1 and 100. Default is 1. Useful for navigation tasks like pressing arrow keys multiple times."
        ),
      scroll_direction: z
        .enum(["up", "down", "left", "right"])
        .optional()
        .describe("The direction to scroll. Required for `scroll`."),
      scroll_amount: z
        .number()
        .min(1)
        .max(10)
        .optional()
        .describe("The number of scroll wheel ticks. Optional for `scroll`, defaults to 3."),
      start_coordinate: z
        .array(z.number())
        .min(2)
        .max(2)
        .optional()
        .describe("(x, y): The starting coordinates for `left_click_drag`."),
      text: z
        .string()
        .optional()
        .describe(
          'The text to type (for `type` action) or the key(s) to press (for `key` action). For `key` action: Provide space-separated keys (e.g., "Backspace Backspace Delete"). Supports keyboard shortcuts using the platform\'s modifier key (use "cmd" on Mac, "ctrl" on Windows/Linux, e.g., "cmd+a" or "ctrl+a" for select all).'
        ),
      save_to_disk: z
        .boolean()
        .optional()
        .describe(
          "Optional, for the `screenshot` and `zoom` actions. Set true to write the captured image to disk (under ~/.config/open-claude-in-chrome/screenshots/) and return its absolute path in the result so it can be opened or shared. Default false."
        ),
    },
  },
  {
    name: "find",
    description:
      'Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content (e.g., "organic mango product"). Returns up to 20 matching elements with references that can be used with other tools. If more than 20 matches exist, you\'ll be notified to use a more specific query. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
    paramShape: {
      query: z
        .string()
        .describe(
          'Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")'
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID to search in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
    },
  },
  {
    name: "form_input",
    description:
      "Set values in form elements using element reference ID from the read_page tool. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      ref: z.string().describe('Element reference ID from the read_page tool (e.g., "ref_1", "ref_2")'),
      value: z
        .union([z.string(), z.boolean(), z.number()])
        .describe(
          "The value to set. For checkboxes use boolean, for selects use option value or text, for other inputs use appropriate string/number"
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID to set form value in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
    },
  },
  {
    name: "get_page_text",
    description:
      "Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      tabId: z
        .number()
        .describe(
          "Tab ID to extract text from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
    },
  },

  {
    name: "javascript_tool",
    description:
      "Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      action: z.literal("javascript_exec").describe("Must be set to 'javascript_exec'"),
      text: z
        .string()
        .describe(
          "The JavaScript code to execute. The code will be evaluated in the page context. The result of the last expression will be returned automatically. Do NOT use 'return' statements - just write the expression you want to evaluate (e.g., 'window.myData.value' not 'return window.myData.value'). You can access and modify the DOM, call page functions, and interact with page variables."
        ),
      tabId: z
        .number()
        .describe(
          "Tab ID to execute the code in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
    },
  },
  {
    name: "read_page",
    description:
      "Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones. Output is limited to 50000 characters by default. If the output exceeds this limit, you will receive an error asking you to specify a smaller depth or focus on a specific element using ref_id. Optionally filter for only interactive elements. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      tabId: z
        .number()
        .describe(
          "Tab ID to read from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
      filter: z
        .enum(["interactive", "all"])
        .optional()
        .describe(
          'Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements including non-visible ones (default: all elements)'
        ),
      depth: z
        .number()
        .optional()
        .describe("Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large."),
      ref_id: z
        .string()
        .optional()
        .describe(
          "Reference ID of a parent element to read. Will return the specified element and all its children. Use this to focus on a specific part of the page when output is too large."
        ),
      max_chars: z
        .number()
        .optional()
        .describe("Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs."),
    },
  },
  {
    name: "resize_window",
    description:
      "Resize the current browser window to specified dimensions. Useful for testing responsive designs or setting up specific screen sizes. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    paramShape: {
      width: z.number().describe("Target window width in pixels"),
      height: z.number().describe("Target window height in pixels"),
      tabId: z
        .number()
        .describe(
          "Tab ID to get the window for. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
    },
  },




  {
    name: "set_tab_focus",
    description:
      "Bring a tab to the user's attention: make it the selected tab in its window, and optionally raise that window in front of every other application. Browser automation never needs this — every tool drives background tabs normally, and nothing else here selects a tab or steals focus — so this is yours to use at your discretion, when the user should actually be looking at something. Reach for it when: they asked to be kept in the loop or told about problems and you hit something worth their eyes; you need a decision or confirmation before doing something consequential or irreversible; you have finished something they are waiting to see; or the page only behaves correctly while its tab is visible (media playback, visibility-dependent apps, timers that throttle in the background). Default to not calling it — routine progress does not warrant an interruption.",
    paramShape: {
      tabId: z
        .number()
        .describe(
          "Tab ID to surface. Must be a tab in the current group. Use tabs_context_mcp if you don't have a valid tab ID."
        ),
      focus_window: z
        .boolean()
        .optional()
        .describe(
          "Also raise the browser window above every other application, interrupting whatever the user is doing right now, in whatever app they are in. Use when the interruption is genuinely warranted; leave false (default) to select the tab quietly so they see it whenever they next look at the browser."
        ),
    },
  },


  {
    name: "file_upload",
    description:
      'Upload one or more local files (by absolute path) to a file input element on the page. Use read_page or find to locate the <input type="file">, then pass its ref — do not click file inputs, which opens a native picker you cannot see. Each file must already exist on this machine (the same machine as the browser); the real path is passed straight to the browser, no staging. Keep the combined size of all files in a single call under ~10 MB.',
    paramShape: {
      paths: z
        .array(z.string())
        .describe(
          "Absolute paths to the files to upload (e.g., ['/home/user/report.pdf']). Each file must already exist on this machine."
        ),
      ref: z
        .string()
        .describe('Element reference ID of the file input from read_page or find tools (e.g., "ref_1", "ref_2").'),
      tabId: z
        .number()
        .describe(
          "Tab ID where the file input is located. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."
        ),
    },
  },
];
