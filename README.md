# DocScan

**https://evanking17.github.io/docscan/**

Scan paper documents to PDF with a phone camera.

- **Nothing is sent anywhere.** No server, no account, no uploads. Photos are processed in the
  browser and the session is kept in the browser's own storage on the device.
- **Finds the page.** Each photo is searched for the sheet of paper and its four corners are
  placed automatically. Drag a corner or an edge to adjust it. A round magnifier shows the
  pixels under the point being placed, with a crosshair, so it can be lined up exactly.
- **Straightens it.** The page is flattened from whatever angle it was shot at. The real shape
  of the sheet is worked out from the perspective, not from the photo, so a tilted page comes
  out square. A page that is Letter- or A4-shaped is made exactly that shape.
- **Filters:** Original, Enhanced (shadows removed, colour kept), Grayscale, B&W.
- **Pages:** tap one to change its filter or rotation, long-press and drag to reorder, the
  menu on each page to move or delete it. Deleting can be undone.
- **PDF:** named, sized to Auto, Letter or A4, then shared (Files, Mail, Drive, etc.) or saved.
- **Works offline** once it has loaded once. Add it to the home screen to use it like an app.
- **Survives a reload.** Every change is saved as it happens.

## How it's built

Static files, no build step. GitHub Pages serves `main` from the repository root.

| Path | |
|---|---|
| `index.html`, `css/style.css` | the three screens: pages, crop, page |
| `js/app.js` | startup, hash routing, scanner status, service worker registration |
| `js/store.js`, `js/storage.js` | session state, persisted to IndexedDB on every change |
| `js/capture.js` | camera and gallery input, EXIF-correct decode, downscale to 3200 px |
| `js/cv-client.js` | loads OpenCV and talks to the worker |
| `js/worker/cv-worker.js` | edge detection, perspective warp, filters (OpenCV, off the UI thread) |
| `js/pipeline.js` | background processing queue |
| `js/pdf.js` | PDF assembly with pdf-lib |
| `js/views/*` | the screens and the export sheet |
| `vendor/` | OpenCV.js 4.9.0 and pdf-lib 1.17.1, served from here so nothing loads from a CDN |
| `sw.js` | cache-first service worker |

## Deploying

Push to `main`. **Bump `VERSION` in `sw.js`** whenever any cached file changes, or installed
copies keep serving the old one.

## Testing locally

```
python -m http.server 8000
```

then open http://localhost:8000. The camera input needs HTTPS on a phone, so test phone
capture on the Pages URL (or through a tunnel such as `cloudflared tunnel --url http://localhost:8000`).
