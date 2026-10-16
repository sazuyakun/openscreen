# Editing with Claude (MCP)

OpenScreen runs a [Model Context Protocol](https://modelcontextprotocol.io) server inside the app. Claude, or any MCP client, can then edit the project open in the editor while you work. Edits go through the editor's own state and undo history, so they appear immediately, and each one undoes with **Cmd+Z** like an edit you made yourself.

## Connect Claude Code

1. Open OpenScreen. The server starts with the app; **MCP** in the menu bar shows its status.
2. Choose **MCP → Copy Claude Code Setup Command** and run it in a terminal, or run:

   ```bash
   claude mcp add --transport http --scope user openscreen http://127.0.0.1:39251/mcp
   ```

3. Start a new Claude Code session. The `openscreen` tools are available while OpenScreen is running.

For Claude Desktop, Cursor or other clients, add an HTTP MCP server with the URL `http://127.0.0.1:39251/mcp`.

## How it works

- **The open project is live.** Tools that leave out `project` act on whatever the editor shows. The editor gets a toast such as "Claude added a zoom", and the change sits in the normal undo history. Nothing is written to disk until you save, or until Claude calls `save_project`.
- **Other projects are edited on disk.** Passing a `.openscreen` path edits that file directly, with its own undo snapshots. If the path is the open project, the live editor is used instead.
- **Claude can see the result.** `preview_frame` returns a screenshot of the editor preview at a given time, with wallpaper, zoom, cursor and annotations. `get_frame` returns the raw recording.

## Tools

| Tool | What it does |
| --- | --- |
| `editor_status` | Whether the editor is open, the project, unsaved changes, playhead |
| `list_projects` / `create_project` / `open_project` / `save_project` | Find, create, open and save projects |
| `get_project` | Timeline (with ids), style, length before and after edits |
| `get_cursor_activity` | Click times and positions, and stretches where the cursor sat still |
| `get_frame` / `preview_frame` | Raw recording frame / rendered editor preview |
| `seek` | Move the playhead |
| `add_zoom` / `auto_zoom` | Zoom on a point; zoom automatically around click bursts or cursor pauses (`dwell` matches the magic wand) |
| `add_trim` / `trim_dead_air` | Cut a section; cut stretches where the cursor is still, the audio is silent and the screen is static |
| `add_speed` | Speed up or slow down a section |
| `add_annotation` | Text label, arrow or blur/mosaic box |
| `update_region` / `remove_regions` | Change or delete regions |
| `set_style` / `copy_style` | Wallpaper, padding, corners, shadow, aspect ratio, crop, webcam, export settings; copy a look across projects |
| `undo` | Undo the editor's last change, or restore a file's previous version |

Times are in seconds of the original recording. Positions are fractions (0–1) of the video frame.

## Settings and security

- The server listens on `127.0.0.1` only, and rejects requests from web pages (`Origin` check) and DNS rebinding (`Host` check).
- Turn it off with **MCP → Enable MCP Server**. The choice is saved in `mcp-server.json` in the app's data folder.
- Environment variables: `OPENSCREEN_MCP_PORT` (default `39251`), `OPENSCREEN_MCP_DISABLED=1`, `OPENSCREEN_PROJECT_DIRS` (extra folders for `list_projects`).
- `get_frame` and `trim_dead_air` use FFmpeg when it's installed (`brew install ffmpeg`). Without FFmpeg, dead-air detection uses the cursor only.

## Code

- `electron/mcp/` holds the server: `index.ts` (HTTP, settings), `tools.ts` (tool definitions), `bridge.ts` (main process to editor IPC), `timeline.ts` (pure timeline maths, unit-tested), `media.ts` (FFmpeg), `projectFiles.ts` (projects on disk).
- `src/components/video-editor/useMcpBridge.ts` and the `mcpHandlersRef` block in `VideoEditor.tsx` apply requests to the editor.
- `tests/e2e/mcp-live-edit.spec.ts` drives the server against the real app (`npx vite build && npx playwright test tests/e2e/mcp-live-edit.spec.ts`).
