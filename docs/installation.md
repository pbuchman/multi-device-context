# Installing Multi Device Context

If the client requests the one-time local history migration, reconnect and close
older app tabs to complete it. Unsent drafts and the outbox are preserved. Synchronized
history is now memory-only and requires a connection after restarting the app.

## Choose your installer

| Platform | Artifact | Compatibility target |
| --- | --- | --- |
| Windows | `Multi-Device-Context-VERSION-win-x64.exe` | x64 |
| macOS | `Multi-Device-Context-VERSION-mac-arm64.dmg` | Apple Silicon, macOS 13+ |

Download the installer from the versioned release in the public
[pbuchman/multi-device-context repository](https://github.com/pbuchman/multi-device-context/releases).
The release also contains `SHA256SUMS.txt`. Compare the installer checksum before
running it if the file was copied between machines. No developer tools or manual
application configuration are required to use a published release.

The Windows installer has no code-signing identity. The macOS application has an
ad-hoc signature required for its Apple Silicon package; it is not Developer ID
signed or notarized. These are Preview builds. Neither platform should be
presented as having a verified publisher.

## Windows

Open the `.exe` installer and follow its per-user installation wizard. Launch
**Multi Device Context** from the Start menu. If Windows presents a reputation
warning, review the exact file and source before choosing the available per-app
exception. Organization policy or Smart App Control can prevent unsigned apps;
record that as a blocked installation instead of disabling system protections.

The app starts at login by default and stays in the system tray when its window
is closed. Its startup setting reports the operating system's effective setting;
Task Manager may disable an otherwise registered startup entry.

## macOS

Open the `.dmg`, drag **Multi Device Context** into **Applications**, then eject
the disk image. Open the installed app from Applications. Do not run it from the
disk image if you want a stable login item and update location.

macOS may block the first launch because the app is not notarized. After trying
to open this specific app, use **System Settings → Privacy & Security → Open
Anyway**, then confirm the application name. This is Apple's documented per-app
exception; a device-management policy can disallow it. See
[Apple's instructions](https://support.apple.com/102445).

The app remains in the menu bar when the window closes. Check **Launch at login**
in the app's tray menu or settings, and verify the actual login launch on your
Mac. Confirm login launch on the target Mac after a real logout/login cycle.

## Sign in and share

1. Choose **Continue with Google**. The system browser opens Auth0's Google login.
2. Sign in using the same Google account on both computers. Allow the browser to
   return to Multi Device Context when prompted.
3. Open or create a context. Paste text, a link, code, a screenshot or copied files.
   Ordinary text paste edits the draft. Use **Send**, or Enter in desktop text
   mode, to share. Desktop code mode and Android use Enter for a new line;
   Ctrl/Cmd+Enter sends in either mode. Pasted files show a confirmation with
   their captured target chat. **Paste and send** sends the current clipboard
   immediately while preserving your typed draft.
4. A newly shared context opens automatically on the other running computer.
   Unsent drafts are preserved. Choose **Copy** or **Save** on an item
   when you need it. Receiving an item never changes the clipboard automatically.

**Share clipboard** in the tray captures the clipboard at that moment and queues
it into a new context. The app does not monitor every clipboard change. Closing
its window keeps it running; **Quit** ends it.

Text is limited to 262,144 UTF-8 bytes. Each file may be up to 100 MiB; a native
clipboard capture may contain at most 32 files totaling 100 MiB. Local queued
clipboard captures have a 256 MiB total limit. Folders, network file locations,
links to local files, empty files and unsupported application-specific clipboard
formats produce an explanation. Rich content with a plain-text representation is
shared as text. Files retain their original bytes.

Below 840 CSS pixels, **Open chats menu** reveals the searchable chat list,
**New chat**, refresh, and Settings. Wider windows keep that same sidebar open.
An empty new chat stays out of the list until it has content or a name. Search
shows a single clear control only while a query is present. Each message has
Copy, Delete, and More controls; deleting the final message also deletes the
empty context after confirmation.
Click an image message to open a full-window preview inside the application.
Right-click or Control-click the thumbnail or enlarged image and choose **Copy
image**. PNG images keep their bytes; other browser-renderable image formats are
decoded to PNG for consistent clipboard support. Saving still preserves the
original file.
With a mouse or trackpad, chat rows are 32 px high; touch devices retain 48 px
hit targets. In wide windows, drag the separator beside the sidebar to resize it
between 220 and 480 px. The main panel keeps at least 360 px. Focus the separator
and use Left/Right arrows for 10 px steps or Home/End for its limits; double-click
it to restore 274 px. The preferred width is saved locally for each account.
Narrowing the window does not replace that preference.

The sidebar footer shows your account name and email. Open Settings to see the
full values. If the identity provider is unavailable, sharing remains usable and
the account area displays **Signed in / Account details unavailable**. Profile
details are kept only for the current session. The desktop uses the signed
profile already verified during sign-in and loads a bounded Google profile image
without saving it to the account store. The browser uses its Auth0 SDK profile,
and the server lookup is a fallback. Temporary lookup failures retry in the
background; **Settings → Retry account details** retries without signing out.
The settings panel explains a failed lookup while chats remain usable.

Right-click a chat, Control-click on macOS, or focus it and press Shift+F10 or the
Menu key to open its menu. The row's **…** button opens the same desktop menu:
**Rename chat**, **Copy link**, and **Delete chat…**. Opening the menu leaves the
current conversation and its draft unchanged. Unsent local chats have no copyable
link. Use arrow keys and Enter to choose an action, or Escape to close the menu.
Phones retain the chat options sheet.

Both refresh controls update chats, messages, and deletions. Circular arrows and
**Refreshing…** show the operation in progress, including the access check. A
manual refresh finishes with **Refresh complete**, or an error explaining why it
failed. Pending sends and offline status remain visible independently. Message
**Copy** and **Message options** remain reachable without hovering.

## Desktop keyboard shortcuts

Desktop 0.5.2 adds these commands to the native application menu. Install the
updated desktop application to get its menu and Quit handling; reloading the
hosted interface alone cannot update the native shell.

| Action | macOS | Windows |
| --- | --- | --- |
| New chat | Cmd+N | Ctrl+N |
| Reload interface | Cmd+R | Ctrl+R or F5 |
| Delete current chat, with confirmation | Cmd+Shift+Backspace | Ctrl+Shift+Backspace |
| Check for updates | File → Check for updates… | File → Check for updates… |
| Quit application | Cmd+Q | Ctrl+Q |

New chat preserves the previous chat's draft. Delete opens the existing
confirmation dialog. Normal text-editing deletion shortcuts remain unchanged.
Reload and Quit wait for local draft and pending-send writes; if a local save
fails, the app stays open and displays the error. They do not wait for queued
uploads to finish over the network. Closing the window (including Alt+F4 on
Windows) keeps the app running in its tray/menu bar; use Quit to exit.

## Context links, names and agents

Every manual opening starts a fresh context. Unsent drafts remain accessible in
the sidebar. Existing contexts can be opened by their copied HTTPS link; the
**Chat options** panel also offers **Open in app** in the browser. Sign-in preserves the target.

Every context starts with a fallback name. AI-generated names require the
account-level **Settings → AI context titles** setting and are not requested when
that setting is disabled. When enabled, bounded first text or a supported first
image up to 5 MiB is sent to the title model; other files send only name and type.
Rename a context from its menu to choose your own title. Use **Chat options → Delete chat** to delete it
permanently after confirmation; there is no trash or restore. **Deleting…** means
the operation is waiting for confirmation. A failed attempt shows **Deletion
needs retry** and a retry warning; a pending request by itself is not an error.

For agent access, open **Settings → Agent access**, create a named key and store
it privately. The
[agent API and portable skill guide](https://github.com/pbuchman/multi-device-context/blob/main/docs/agent-api.md)
explains setup, watching for new contexts and returning results. Agent keys grant
full access to your data and can be revoked from Settings.

## Connection, updates and removal

If the hosted interface cannot load, the installed app shows a reconnect screen.
Already captured native shares remain encrypted on the computer. Open the app
and choose **Try again** when the connection returns. Pending web shares use the
account's local outbox and retry when the connection returns. Sign-out explains
pending local data before it is discarded.

The desktop app checks the fixed Preview release catalog when it starts and every
six hours while it is running. **File → Check for updates…** checks immediately.
Checks do not download or install anything. Availability, download progress and
the result appear in the app's update banner and Settings. The updater does not
send a GitHub token or other account credential with its public catalog and
release downloads.

On Windows, choose **Update and restart**. The app downloads and verifies the
installer, then waits for local draft and pending-send writes,
then runs the verified per-user NSIS update in the existing installation location.
Closing the window or using ordinary Quit never installs a downloaded update.
The protected login, startup preference and retained application data stay in
place. If the update is cancelled or fails verification, the installed version
continues to run and can be retried. If Windows refuses to start the verified
installer, the app stays open, reports the failure and keeps the verified update
ready for another attempt.

On macOS, choose **Download DMG**. The app downloads, verifies, and opens the
DMG; **Open DMG** reopens an already verified download. Quit Multi Device Context, drag the new app
over **Multi Device Context** in Applications, eject the disk image and reopen the
app. This manual replacement is required because the macOS build is
ad-hoc signed and not notarized. Keep using the per-app Gatekeeper steps above;
the updater does not remove quarantine attributes or bypass Gatekeeper.

Install the first updater-enabled desktop release manually using the instructions
at the top of this page. Older releases cannot discover the new catalog. A manual
download from the versioned release remains the recovery path on either platform;
compare `SHA256SUMS.txt` before installing it. Updating does not clear app data.

Maintainers run the native A→B updater acceptance only on ephemeral Windows x64
and Apple Silicon macOS CI runners with an interactive desktop and OS secure
storage available; `openssl` must be on `PATH`. First build the normal B
installer, retaining its canonical release filename and exact bytes. Run the
platform-neutral boundary tests with
`pnpm --filter @mdc/desktop test:update-harness`. On the matching native runner,
set `MDC_NATIVE_UPDATE_A_TO_B=1`, `MDC_NATIVE_UPDATE_B_VERSION` to B's numeric
version, and `MDC_NATIVE_UPDATE_B_ARTIFACT` to the canonical B `.exe` or `.dmg`,
then run `pnpm --filter @mdc/desktop test:update-native`. CI already supplies
`CI=true`. The runner writes `apps/desktop/release/native-update-a-to-b.json`.

The harness creates test A in a private temporary source copy, substitutes only
compile-time localhost HTTPS catalog/feed constants in that copy, generates a
short-lived test certificate and pins its SPKI, and forces electron-builder to
`--publish never`. Normal
package checks reject the test marker and local URLs. The production source and
the B artifact are hashed before and after the run. Windows installs A to a
non-default per-user directory, proves ordinary Quit does not install the cached
update, then exercises the acknowledged NSIS restart in place. macOS opens the
verified B DMG, performs the explicit quit/mount/manual application replacement,
and restarts B. Both variants check that the installation path, encrypted native
sentinel, and synthetic draft, outbox, and settings data survive. The report is
native CI evidence; it is not a claim that a physical user device was tested.
Before a later normal B installation, the Windows run disables the test login
item, runs the isolated NSIS uninstaller, and verifies that the executable and
non-default uninstall-registry reference are gone.

Before uninstalling, finish or deliberately discard pending shares, sign out,
turn off **Launch at login**, and quit. Use Windows Installed Apps to uninstall,
or move the macOS application from Applications to Trash. Uninstalling the app
does not delete contexts stored in your account. Delete unwanted contexts inside
the app first. Deletion removes the content and attachments; a small server-managed
record containing only deleted IDs remains to block old offline uploads from
restoring them. Those markers stay server-managed and are readable only by the
owner's current clients; clients cannot create or modify them directly.
The Windows uninstaller retains app data for a later reinstall;
signing out clears the account's local data while the app is running.

Copied files use a private local export directory so other applications can paste
them. Old exports are removed on later launches/copies, preserving the current
clipboard's file while it is still selected; sign-out clears those exports. Files
saved explicitly to a location you choose remain there.

If sign-in does not return from the browser, reopen the installed app and retry.
If the callback handler is missing, reinstall the current release. If the app
reports unavailable secure encryption, unlock the system keychain and restart.
Never paste Google codes, access tokens, service-account files or diagnostic
credential objects into an issue or chat.
