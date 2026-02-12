# OpenAI Log Image Renderer (Tampermonkey)

Render conversation images inline in OpenAI Platform conversation logs (`/logs/conv_*`), including:
- `input_image` items with `file_id`
- Markdown image links in assistant text
- Annotated-image placeholder flows (`[ANNOTATED_IMAGE]`)

This userscript is built for `https://platform.openai.com/*`.

## Why This Script

In conversation logs, image-bearing items may appear as text or metadata instead of visible inline images.
This script intercepts the conversation items payload, resolves image URLs, and injects image cards directly into the matching message blocks.

## Features

- Inline rendering inside the correct response/message card in the main logs UI
- Supports `file_id` image resolution through:
  - `GET https://api.openai.com/v1/internal/files/{file_id}/download_link`
- Reuses auth context from platform requests:
  - `Authorization`
  - `OpenAI-Organization`
  - `OpenAI-Project`
- Uses per-conversation header mapping from that conversation's `.../dashboard/conversations/{conv_id}/items` request
- Retry UI for failed image loads
- Request dedupe + cooldown to reduce repeated failed calls / rate-limit pressure
- Automatic handling for SPA route changes

## Installation

### Option 1: Greasy Fork

1. Install Tampermonkey in your browser.
2. Open the Greasy Fork page for this script.
3. Click **Install this script**.

### Option 2: GitHub (manual)

1. Install Tampermonkey.
2. Open `userscripts/openai-log-image-renderer.user.js`.
3. Copy contents into a new Tampermonkey script, or open the raw file URL and install.
4. Save and enable the script.

## Usage

1. Open `https://platform.openai.com/logs/conv_...`
2. Wait for the conversation items request to load.
3. Images should appear inline under their corresponding message blocks.

If images do not appear immediately:
- refresh the page once
- ensure you have permission to view the files in that org/project
- click the script's **Retry** button on error badges

## Configuration

Edit `CONFIG` at the top of the userscript:

- `UI.maxImageWidthPx`
- `UI.borderRadiusPx`
- `UI.showCaption`
- `FEATURE_FLAGS.renderMarkdownImages`
- `FEATURE_FLAGS.renderInputImageByFileId`
- `FEATURE_FLAGS.renderAnnotatedImagePlaceholder`
- `DEBUG.enabled`

## Notes / Limitations

- This script depends on current OpenAI Platform DOM and internal API behavior; UI/API changes may require updates.
- Signed download URLs are time-limited.
- The script is intended for your own account/workspace usage where you are authorized to access those files.
- Not affiliated with OpenAI.

## Privacy & Security

- Runs locally in your browser via Tampermonkey.
- Does not send data to third-party services.
- Uses existing authenticated platform context to request image download links.

## Development

Repository structure:

- `userscripts/openai-log-image-renderer.user.js`
- `README.md`

To test quickly:

1. Enable `DEBUG.enabled = true`
2. Reload the logs page
3. Check browser console for `[OCI]` logs

## License

MIT
