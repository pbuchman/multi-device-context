# Installing Multi Device Context

Version 0.2.0 extends the private preview with automatic titles, context links,
instant switching and agent access. Hosted checks and installed-application
checks passed on Windows x64 and macOS arm64 CI. See
[the acceptance record](https://github.com/pbuchman/multi-device-context/blob/main/docs/verification/v0.2.0.md)
for the evidence and the remaining checks on your own machines.

## Choose your installer

| Computer | Artifact | Compatibility target |
| --- | --- | --- |
| Dell Pro 14 Plus PB14250 | `Multi-Device-Context-VERSION-win-x64.exe` | Windows 11 Enterprise 25H2, x64 (user reported) |
| MacBook Pro M2 | `Multi-Device-Context-VERSION-mac-arm64.dmg` | Apple Silicon; user reports macOS 27.0.1 (26A434), minimum 13 |

Download the installer from the versioned release in the private
[pbuchman/multi-device-context repository](https://github.com/pbuchman/multi-device-context/releases).
The release also contains `SHA256SUMS.txt`. Compare the installer checksum before
running it if the file was copied between machines. No developer tools or manual
application configuration are required to use an accepted release.

The Windows installer has no code-signing identity. The macOS application has an
ad-hoc signature required for its Apple Silicon package; it is not Developer ID
signed or notarized. These are initial private builds. Neither platform should be
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
Mac. The unsigned release's login registration must be confirmed on the target
machine; CI registration is not evidence of a user logout/login cycle.

## Sign in and share

1. Choose **Continue with Google**. The system browser opens Auth0's Google login.
2. Sign in using the same Google account on both computers. Allow the browser to
   return to Multi Device Context when prompted.
3. Open or create a context. Paste text, a link, code, a screenshot or copied files.
   Pasting shares immediately; typed text is shared with Enter.
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

## Context links, names and agents

Every manual opening starts a fresh context. Unsent drafts remain accessible in
the sidebar. Existing contexts can be opened by their copied HTTPS link; the
context menu also offers **Open in desktop app**. Sign-in preserves the target.

Names appear automatically after the first share. Only bounded first text or file
names/types are sent to the title model, never attachment bytes. Rename a context
from its menu to choose your own title. Use the × beside a context to delete it
permanently after confirmation; there is no trash or restore.

For agent access, open **Settings → Agent access**, create a named key and store
it privately. The [agent API and portable skill guide](https://github.com/pbuchman/multi-device-context/blob/main/docs/agent-api.md)
explains setup, watching for new contexts and returning results. Agent keys grant
full access to your data and can be revoked from Settings.

## Connection, updates and removal

If the hosted interface cannot load, the installed app shows a reconnect screen.
Already captured native shares remain encrypted on the computer. Open the app
and choose **Try again** when the connection returns. Pending web shares use the
account's local outbox and retry when the connection returns. Sign-out explains
pending local data before it is discarded.

For an update, download the newer release, quit the app from its tray menu, and
install over the existing Windows application or replace the application in
macOS Applications. Startup preferences and the protected login are retained
unless the deployment's login configuration changes. There is no automatic
updater in this first release.

Before uninstalling, finish or deliberately discard pending shares, sign out,
turn off **Launch at login**, and quit. Use Windows Installed Apps to uninstall,
or move the macOS application from Applications to Trash. Uninstalling the app
does not delete contexts stored in your account. Delete unwanted contexts inside
the app first. Deletion removes the content and attachments; a small server-managed
record containing only deleted IDs remains to block old offline uploads from restoring them.
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
