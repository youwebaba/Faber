# Share live video

Select **Share video** in the chat header. Choose a camera, a Windows screen or an application window. Choose **This PC only** for a local preview, or select one online paired device. Review the source and viewer, approve the native confirmation and select **Start sharing**.

The red **Live** indicator names the selected source and viewer. **Stop** ends capture. Returning to chat keeps the indicator visible. Closing or hiding Faber, reloading the interface, locking Windows or suspending the PC ends the share.

On the selected paired PC, open the host workspace and choose **Watch live**. Closing the viewer, losing its viewing session or revoking the device ends remote sharing. The host must approve a new share before viewing can resume. Camera and screen access cannot be started by a remote request.

Local preview uses a video stream. Paired viewing sends size-limited JPEG frames through the authenticated, encrypted Faber connection, up to 1280 × 720 and five frames per second. Only the current frame is kept in memory. Live sharing records no audio or video to disk.

## Verification

The Windows fixture captured a window created for the test, verified its red pixels, changed it to blue and verified the next frame. A separate run used Chromium’s synthetic camera. Both sent their frames through an actual local relay to a paired controller and stopped when the viewer left. The source and permission tests also cover the top-level frame boundary, audio rejection, a stale viewing session, revocation and timeout.

The desktop acceptance test also used the normal **Share video**, **Review share**, **Start sharing** and **Watch live** controls. It refused the first share, accepted a second share of the test window and verified the red and blue frames in the paired viewer. **Stop watching** released the host video tracks and cleared the indicator. The test intercepted the native confirmation and restricted available capture sources to its own window. Run it with `npm run smoke:media -- --capture-ui`.

Physical camera, whole-display selection and independent-network playback remain acceptance items. [Electron display capture](https://www.electronjs.org/docs/latest/api/desktop-capturer)
