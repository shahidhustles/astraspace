# 01 - Open a loadable React side panel

## Goal

Clicking the Astra Space toolbar action opens a React side panel styled with the base tokens from `DESIGN.md`.

## Files

Create:
- `chrome-extension/vite.config.ts`
- `chrome-extension/src/main.tsx`
- `chrome-extension/src/App.tsx`
- `chrome-extension/src/background.ts`

Modify:
- `chrome-extension/package.json`
- `chrome-extension/index.html`
- `chrome-extension/public/manifest.json`
- `chrome-extension/src/style.css`
- `chrome-extension/tsconfig.json`

## Implementation notes

- Add React 19, the Vite React plugin, Tailwind CSS 4, Chrome types, and the shadcn/ui base setup.
- Replace the popup entry with `side_panel.default_path`. Keep the toolbar action and use a module service worker to enable `openPanelOnActionClick`.
- Configure Vite to emit the side-panel HTML and a stable service-worker filename referenced by the manifest.
- Copy the token seed from `DESIGN.md` into the extension stylesheet. Bundle all executable code with the extension.

## Blocked by

None.

## Done when

- `bun run build:extension` succeeds.
- Loading `chrome-extension/dist` as an unpacked extension and clicking its toolbar action opens a React side panel with Astra Space styling.

