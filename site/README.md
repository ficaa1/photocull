# Project page

The page published at www.filipbiljic.com/photocull/ by `.github/workflows/pages.yml`. Every URL in it is relative, so it works under the `/photocull/` path.

- `index.html`: the page, with its styles inline. It uses no script, tracker or external resource.
- `img/`: screenshots of the app in AVIF and WebP at two widths, and `social.jpg` for link previews.
- `fonts/`: Schibsted Grotesk, self-hosted, with its SIL Open Font License.
- `icon.svg`: the app icon from `assets/icon.svg`.
- `capture.cjs`, `encode.cjs`: how the screenshots are made. Only the files the page loads are published.

## Screenshots

The sample photos are the author's own, copied to anonymous names (`sample-01.JPG`, `sample-05.ARW`, …) with location, owner and serial-number metadata removed. Only the rendered screenshots are committed, never the photos.

```sh
CHROMIUM_PATH=/path/to/chrome node site/capture.cjs SAMPLE_FOLDER /tmp/photocull-shots
node site/encode.cjs /tmp/photocull-shots
```

`capture.cjs` copies the samples to a temporary card named "Sample shoot", starts the Node backend in browser mode and drives the real renderer in headless Chromium at 1440 × 900 and 2× density, as the UI smokes do. Browser mode has no Rust engine, so the script supplies two desktop calls itself: sharpness scores, computed as luminance Laplacian variance on the previews, and the Develop preview, a tone curve over the camera preview with a histogram of the result. Develop's render timings are hidden in the screenshots for that reason. Everything else on screen is the app's own output, including the verified card backup.
