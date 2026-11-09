# Chat media

a3.0 also offers consented **Share video** and paired **Watch live** controls.
Live capture is separate from saved chat attachments: it keeps only the current
bounded frame in memory and stops on disconnection, hiding Faber, locking Windows
or Stop. [Sources, consent and observed limits](LIVE_MEDIA.md)

Faber plays saved audio and video in local and remote chats. Audio has
play/pause, seeking and volume controls. Video has the same controls and a
Fullscreen action. Playback starts when you choose Play. Switching away from a
chat stops its player and cancels its outstanding media transfers. In a2.6,
`media_show` also displays PDF, DOCX, SVG, GIF and APNG attachments. Install a2.6
on both PCs for these previews and document annotations.

## Documents, drawings and animations

PDF previews paint the actual pages, with selectable text when the PDF contains
a text layer. Previous/Next page and zoom controls are inside the preview.
Image-only PDFs remain viewable; Faber does not perform OCR.

DOCX previews show **text reflow**, identified by a persistent notice above the
page. Body paragraphs, bold/italic text and explicit page breaks are supported;
long body text is split into bounded reflow pages. Word pagination, columns,
fonts, floating objects and exact layout are not reproduced. Table text retains
visible row/cell labels. Embedded pictures and objects have visible placeholders;
footnotes/endnotes and omitted header/footer content are identified. Use **Save
original…** to open the unchanged document in a full document editor.

Select PDF or DOCX text and choose **Highlight selection**, or write a page note
and choose **Save note**. Notes and highlights are saved with the chat, immutable
document revision and page. Repeated text uses the selected occurrence. Saved
annotations have Go to page and Delete controls; archived chats remain readable
but cannot change annotations. These annotations do not modify the original file.

SVG previews support zoom, scroll and drag to pan. They are decoded as a separate
image after active content, external references, animation and CSS styles are
removed; a drawing that relies on those features can look different. GIF and
APNG previews start paused, with Play/Pause, Previous/Next frame and zoom.
Animated `.png` files are supported when they contain APNG data. Static images
continue to use `images_show`. Every preview has **Save original…**.

Right-click chat content to open its context menu. Use **Copy text** for selected
text or the relevant message, **Copy image** for a displayed image, and **Save
as** for images, audio or video. Keyboard users can focus the content and use
Shift+F10 or the context-menu key. Escape closes the menu. Copy and Save As act
on the PC you are using, even when the chat belongs to another PC.

## Publishing a recording or generated file

a2.7 adds supplied music tracks and timed text. MIDI `.mid`/`.midi` files have
Play/Pause, seeking, volume and an inspector. Playback uses the bundled
SpessaSynth synthesizer and MIT-licensed FluidR3Mono sound bank on the PC you
are using, including when the file belongs to a paired host. It does not send
MIDI to external hardware. Cancel stops playback/loading; Reopen starts paused.

Group 2–8 supplied PCM WAV stems with `media_show {tracks:[{path,label?}],title?}`.
They share one audio clock and seek position, with per-track Mute, Solo, volume
and Save original. This plays supplied stems; it does not separate a recording.
Grouped stems accept PCM WAV up to 32 MiB each, 64 MiB per group and 128 MiB
decoded PCM at 48 kHz. Existing individual audio formats remain available.

Attach SRT or VTT files with `captions:[{path,label?}]` alongside an audio/video
`path` or stem group. The caption picker selects a supplied track or turns
captions off. Video captions remain available in fullscreen. Timed transcript
segments highlight during playback and seek when clicked. Long transcripts use
bounded segment pages with a Follow current segment control. Missing, reversed
or otherwise invalid timing is displayed as an error; the original subtitle
can still be saved. No speech-recognition or translation model is run.

For example:

```json
{"path":"clip.webm","captions":[{"path":"clip.vtt","label":"English"}]}
```

```json
{"title":"Supplied stems","tracks":[{"path":"vocals.wav","label":"Vocals"},{"path":"drums.wav","label":"Drums"}],"captions":[{"path":"lyrics.srt","label":"Lyrics"}]}
```

Each member must be inside an authorized project and is copied independently.
Saving uses the original file bytes. Paired transfers remain authenticated,
bounded and cancelable. Reconnect never automatically resumes music playback.
See [a2.7 media verification](docs/a2.7-media.md) for supported MIDI/timing limits
and the pinned synthesizer/sound-bank licenses.

An agent uses `media_show {path}` with a project-relative file path. It supports
WAV, MP3, M4A and Ogg audio, and MP4 and WebM video, up to 512 MiB per file.
PDF and DOCX have a 64 MiB limit, SVG 4 MiB, and GIF/APNG 16 MiB.
The file must be in an authorized project. Faber checks the file type and copies
it into private chat storage so later edits to the original do not change the
displayed attachment. The model receives a descriptor, not the media bytes.

Playback depends on the codecs inside the file. An unsupported or damaged clip
shows an error; Save As remains available. Faber does not transcode media or
automatically fetch arbitrary media URLs. Playback support does not itself
connect a music/video generation service. A configured tool or model integration
must first produce the file.

## Interactive outputs in a2.8

Use `media_show {path}` for `.chart.json` charts, `.geojson` maps or
`.diagram.json` diagrams. Hover or select an item to inspect its values or full
label, drag to pan, and use Zoom in/out or Ctrl+wheel. Chart series can be hidden
with their legend buttons. Maps display supplied geographic data with a latitude
and longitude grid; external map tiles and data are not fetched. Save original
retains the complete data or diagram description.

An `.html` or `.htm` demo opens when you choose **Run demo**. Optional
`assets:[{path,name?}]` supplies its local JavaScript, CSS, images, fonts or data;
`name` is the relative virtual name referenced by the HTML. The inspector lists
each saved asset and provides Save asset. Every supplied file requires the same
project authorization as the main HTML and becomes an immutable chat attachment.

HTML runs in a separate sandboxed process without Faber or Node APIs, credentials,
parent-page access, external network, devices, file selection, popups, forms or
nested frames. A blocked document navigation stops the preview. Demo errors
appear beside its controls. **Pause** freezes its JavaScript and animation;
**Resume** continues it. **Stop**, Escape, switching chats or losing the paired
connection discards the running process. Another Run starts a fresh origin and
fresh demo state. Reconnecting does not start an HTML demo automatically.

Charts support bar, line and scatter series with up to 5,000 points total.
GeoJSON supports up to 1,000 features and 20,000 positions. Diagrams support up
to 200 labeled nodes and 600 directed edges, with supplied positions or automatic
layout. Source limits are 2 MiB for a chart or HTML, 4 MiB for a map and 1 MiB for
a diagram. HTML accepts up to 32 assets, 8 MiB each and 16 MiB including the HTML.
It pauses after one minute of running time. A process memory watchdog stops
previews above 256 MiB; this is a sampled safeguard rather than a hard OS quota.
See [formats and verification](docs/a2.8-media.md).

## Remote playback

Install a2.4 or later on both PCs for remote audio/video playback. The host retains the
attachment. The controlling PC requests bounded chunks through the paired,
encrypted connection, including the ranges needed when seeking. Chat refreshes
carry small descriptors rather than repeated audio/video data. The connection
must remain available while opening, playing, annotating or saving remote media.
After reconnecting, saved document annotations are restored and animations remain
paused. Revoking a paired device blocks further transfers and annotation changes.

Older hosts remain usable for their existing chat capabilities. They do not
advertise the a2.4 media-reference capability. The controller does not use a
displayed filename as permission to open arbitrary files on the host.

## Ownership and desktop boundary

`media_show` is a read tool for an authorized project, with cancellation and
path revalidation. It returns `{media:{id,kind,mimeType,bytes,name,revision?}}`; durable
tool messages and events retain the descriptor. Bytes live in the profile's
private `chat-media` directory, outside model input and source workbenches.
Deleting the owning chat or project removes its private media copies. Failed
publications are cleaned up; startup also removes orphaned copies from an
interrupted publication. The original project file is left alone.

The renderer uses `faber://app/media/<chatId>/<mediaId>` with an optional paired
device ID. The desktop validates ownership, format, size and range, and serves
only the requested attachment. Clipboard and Save As use the narrow user
bridge. Only a native file chooser supplies a save path; temporary writes are
committed after the transfer succeeds. Cancellation preserves an existing file.

Local addon and shell permissions retain Windows-account authority; private
media storage is not an operating-system sandbox.

Untrusted previews use a separate sandboxed `faber-preview://viewer` origin with
no Faber bridge, Node access or parent DOM access. Its network policy permits
only an exact app-owned static asset allowlist. Documents cannot follow arbitrary
paths, run PDF JavaScript, load external links/resources, or obtain app privileges.
PDF.js is pinned and its bundled decoder/font assets are integrity-checked.
Decoder, archive expansion, text, page/frame and annotation limits reject damaged
or excessive inputs. A preview error leaves Save original available.

## Development checks

In a source checkout, install the root dependencies and `npm ci --prefix relay`,
then run `npm run smoke:media` for real Electron players and an isolated relay.
`node --test test/desktop-media-relay.fixture.mjs` separately checks a transfer
above 64 MiB. Both use synthetic files and temporary profiles, with no model
provider calls. These source fixtures need the separate relay source; the
desktop installer does not bundle the relay operator service.
