# PhotoCull server

PhotoCull can run as a self-hosted web app on a home server, next to the photos, so you can cull from any browser on the network: a phone, a tablet or another computer. It offers the culling workflow: previews, focus analysis, burst stacks, picks, rejects, ratings, colors, XMP sidecars, Copy picks and Delete. Develop, external editors, export, camera cards and card backup stay in the desktop app.

## How it works

1. **Open** a folder with the folder browser. It shows only the photo folders you configure.
2. PhotoCull **prepares** it in the background: every thumbnail first, then review previews and focus scores for the whole folder. Preparation continues with the browser closed. **Prepare in background** in the folder browser queues a folder without opening it. Folders are prepared one at a time and show **Queued**, **Thumbnails n/N**, **Focus n/N** or **Ready**. A pill in the corner follows the current job.
3. **Cull** as in the desktop app. Prepared photos open instantly. Decisions are saved on the server and written to XMP sidecars next to the photos (Settings → Metadata), so the desktop app and editors see them.
4. **Delete** rejects, or empty PhotoCull's Trash, to move the photos to the **server trash**.

A reloaded page returns to the last opened folder. The server keeps up to eight folders open, so several browsers can use it. Each browser sees the others' decisions after reopening the folder.

Measured on a home server (6-core i7-8700K; photos on a NAS over gigabit NFS; Sony A7 III RAW + JPEG pairs): a 414-photo folder was fully prepared in 161 s, with thumbnails done after 27 s. Afterwards the first photo appeared 0.2 s after opening the folder, moving to the next photo took 10–50 ms, and the full-resolution 100% view took 0.3 s.

## Docker Compose

`compose.yaml` in the repository is a template. Copy it next to a checkout, edit the marked lines and run:

```sh
docker compose up -d --build
```

Then open `http://<server address>:8787` from any device on the network. Settings:

| Setting | Meaning |
| --- | --- |
| `PHOTOCULL_ROOTS` | **Required.** The folders the folder browser can open: `Name=/path`, several separated by `;`, e.g. `Photos=/library/Photos;Uploads=/library/uploads`. A bare `/path` is named after its last folder. Nothing outside these folders can be browsed, opened, copied to or deleted, including through symlinks. |
| `PHOTOCULL_TRASH` | Where Delete moves photos. Leave empty to disable deletion. See [Server trash](#server-trash). |
| `PHOTOCULL_TRASH_DAYS` | Days before a trashed photo is removed for good. Default 30; `0` keeps everything. |
| `PHOTOCULL_PREVIEW_CACHE_GB` | Preview cache size: 1, 2, 5 or 10 GB. The least recently used photos are evicted first. |
| `PHOTOCULL_PASSWORD` | Optional sign-in. Without it, anyone who can reach the port can cull and delete. Changing it signs every browser out. |
| `PHOTOCULL_HOSTNAMES` | Host names, besides IP addresses and `localhost`, that the app is reached by, comma separated: a local DNS name or a reverse-proxy domain. Requests addressed to any other name are refused. |
| `PHOTOCULL_PORT`, `PHOTOCULL_HOST` | Where the server listens inside the container; defaults `8080` and `0.0.0.0`. Publish a different host port in `ports:` instead of changing these. |

Volumes:

- **The photo library.** Mount the folder that holds the roots *and* the trash as **one** volume. Linux cannot rename a file from one mount to another, even two mounts of the same disk, so a trash on a different mount turns every Delete into a copy and a removal.
- **`/data`.** Settings, decisions, logs and the preview cache. Local fast storage is best.

`user:` must be able to read the photos and write next to them, because XMP sidecars and trash moves are written there. Use the numeric user and group that own the photos.

### Preview cache size

For RAW + JPEG pairs the cache keeps a copy of each camera JPEG beside the small display previews, so the full-resolution view is read from the cache rather than the library. Expect about 6.5 MB per photo, so 10 GB keeps roughly the 1,500 most recently prepared photos ready. A photo that has been evicted is prepared again when it is next shown.

## Server trash

Delete moves each photo with its companion JPEG and XMP sidecars to:

```
<PHOTOCULL_TRASH>/<YYYY-MM-DD>/<root name>/<path inside the root>
```

A new name such as `DSC0001 (2).ARW` avoids overwriting anything already there. Each day folder has a `photocull-trash.jsonl` log with one line per file: when it was deleted, where it came from and where it went. To restore a photo, move it back to the `from` path, for example with a file manager or copyparty, then reopen the folder. Day folders older than `PHOTOCULL_TRASH_DAYS` are removed when the server starts and every six hours. Only folders named like a date are touched.

Put the trash outside the roots, or in a hidden (`.`) folder, so trashed photos never appear in the folder browser or in other photo apps that index the roots.

Deleting permanently, without the trash, is still offered in the Delete dialog.

## Security

- Run it on your home network. Before exposing it through a reverse proxy, set `PHOTOCULL_PASSWORD` or put it behind the proxy's own sign-in, and add the domain to `PHOTOCULL_HOSTNAMES`.
- Browsers sign in with an HttpOnly, SameSite=Strict cookie. Requests that change anything also need a custom header, which other sites cannot send.
- Only culling methods are available over the network. Methods that would read or write arbitrary paths (settings bundles, recipe files, the decisions manifest, editors, card backup) are refused.

## Running without Docker

```sh
npm ci --omit=dev
PHOTOCULL_ROOTS="Photos=/srv/photos" PHOTOCULL_TRASH=/srv/.photocull-trash PHOTOCULL_DATA_DIR=./data npm run server
```

ExifTool needs Perl on Linux.

## Not yet

- Touch gestures (swipe between photos, pinch to zoom). Use the Pick, Reject and arrow buttons, or a keyboard.
- Live updates between browsers culling the same folder at once.
- Restoring from the server trash inside the app.
