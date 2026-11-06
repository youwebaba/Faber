# Chat media

Faber a2.4 plays saved audio and video in local and remote chats. Audio has
play/pause, seeking and volume controls. Video has the same controls and a
Fullscreen action. Playback starts when you choose Play. Switching away from a
chat stops its player and cancels its outstanding media transfers.

Right-click chat content to open its context menu. Use **Copy text** for selected
text or the relevant message, **Copy image** for a displayed image, and **Save
as** for images, audio or video. Keyboard users can focus the content and use
Shift+F10 or the context-menu key. Escape closes the menu. Copy and Save As act
on the PC you are using, even when the chat belongs to another PC.

## Publishing a recording or generated file

An agent uses `media_show {path}` with a project-relative file path. It supports
WAV, MP3, M4A and Ogg audio, and MP4 and WebM video, up to 512 MiB per file.
The file must be in an authorized project. Faber checks the file type and copies
it into private chat storage so later edits to the original do not change the
displayed attachment. The model receives a descriptor, not the media bytes.

Playback depends on the codecs inside the file. An unsupported or damaged clip
shows an error; Save As remains available. Faber does not transcode media or
automatically fetch arbitrary media URLs. Playback support does not itself
connect a music/video generation service. A configured tool or model integration
must first produce the file. Images continue to use `images_show`.

## Remote playback

Install a2.4 on both PCs for remote audio/video playback. The host retains the
attachment. The controlling PC requests bounded chunks through the paired,
encrypted connection, including the ranges needed when seeking. Chat refreshes
carry small descriptors rather than repeated audio/video data. The connection
must remain available while playing or saving remote media.

Older hosts remain usable for their existing chat capabilities. They do not
advertise the a2.4 media-reference capability. The controller does not use a
displayed filename as permission to open arbitrary files on the host.

## Ownership and desktop boundary

`media_show` is a read tool for an authorized project, with cancellation and
path revalidation. It returns `{media:{id,kind,mimeType,bytes,name}}`; durable
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

## Development checks

In a source checkout, install the root dependencies and `npm ci --prefix relay`,
then run `npm run smoke:media` for real Electron players and an isolated relay.
`node --test test/desktop-media-relay.fixture.mjs` separately checks a transfer
above 64 MiB. Both use synthetic files and temporary profiles, with no model
provider calls. These source fixtures need the separate relay source; the
desktop installer does not bundle the relay operator service.
