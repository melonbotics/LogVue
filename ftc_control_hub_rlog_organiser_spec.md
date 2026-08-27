# FTC Control Hub RLOG Organiser — Specification

## 1. Purpose

This tool is a desktop GUI for browsing `.rlog` files on an FTC Control Hub over ADB, importing them into a local archive, and annotating them with useful competition or testing context.

The tool should support two main workflows:

1. **Competition workflow**
   - Pull official event and match information from FTCScout when internet is available.
   - Cache that information for offline use.
   - Present the official matches for a selected team.
   - Allow one-click import of logs into the relevant match/session.
   - Support extra practice, tuning, replay, crash, or test sessions between official matches.

2. **General workflow**
   - Browse logs currently on the Control Hub.
   - Import logs into date/session-based folders.
   - Annotate logs with session names, tags, notes, robot, purpose, etc.
   - Work without FTCScout or internet access.

The core abstraction is:

> Everything is a session. A competition is a specialised session. A match is a child session. A tuning run, practice match, test day, or debug session is also a session.

---

## 2. Core Concepts

### 2.1 Session

A session is the main organisational unit.

A session can:

- Contain files, such as `.rlog`, crash traces, notes, video, screenshots, or AdvantageScope exports.
- Contain child sessions.
- Have metadata stored in `session.json`.
- Have human-readable notes stored in `notes.md`.
- Be indexed and filtered in the UI.

Examples of sessions:

- Competition event
- Official match
- Practice match
- Replay
- Workshop testing day
- Drivebase tuning session
- Shooter PID tuning session
- Localization debug session
- Crash/debug investigation

### 2.2 Competition as a Session

A competition is a parent session with type:

```json
"session_type": "competition_event"
```

It can contain child sessions such as:

```text
APOC26/
  Q4_Blue_B2/
  Drivebase_Tuning_After_Q4/
  Q9_Red_R1/
  Practice_Field_Run_1/
```

Official matches are generated or updated from FTCScout. Custom sessions are created manually by the user.

### 2.3 Match as a Session

A match is a child session of a competition event.

A match can contain more than one log:

- Auto log
- TeleOp log
- Replay log
- Crash log
- App restart log
- Tuning log
- Related notes or videos

The tool must not assume one match equals one `.rlog`.

### 2.4 General Session

When not at a competition, the user should be able to import logs into date/session-oriented folders.

Example:

```text
FTCLogArchive/
  2026/
    2026-07-08_Workshop_Testing/
      Shooter_PID/
      Localization_Debug/
```

---

## 3. Archive Folder Structure

The folder structure is the source of truth. Metadata lives alongside the files it describes.

Recommended root structure:

```text
FTCLogArchive/
  .logvue/
    index.sqlite
  2026/
    APOC26/
      session.json
      notes.md

      Q4_Blue_B2/
        session.json
        notes.md
        AutoOpMode_log_20260704_115005_104.rlog
        TeleOp_log_20260704_115327_882.rlog

      Drivebase_Tuning_After_Q4/
        session.json
        notes.md
        DriveTest_log_20260704_121552_901.rlog

      Q9_Red_R1/
        session.json
        notes.md
        RedTeleOp_log_20260704_124201_662.rlog

    2026-07-08_Workshop_Testing/
      session.json
      notes.md

      Shooter_PID/
        session.json
        notes.md
        ShooterTuning_log_20260708_190211_441.rlog

      Localization_Debug/
        session.json
        notes.md
        LocalizationTest_log_20260708_193410_018.rlog
```

### 3.1 Folder Names

The folder name should always be the human-readable session name.

Examples:

```text
Q4_Blue_B2/
Drivebase_Tuning_After_Q4/
Q9_Red_R1/
Shooter_PID/
Localization_Debug/
```

The app should not require sequence prefixes such as `001_`, `002_`, etc.

Reason:

- Users may manually create or import folders.
- Users may add sessions later between existing sessions.
- Renaming folders to insert a new item would be annoying and fragile.
- A natural folder name makes the archive easier to browse outside the app.

The app should treat the folder name as the session name when first discovering a folder that does not yet have metadata.

If a folder contains no `session.json`, the app should be able to create one automatically using the folder name as `display_name`.

Ordering, timestamps, match context, and rich annotations should live in `session.json` and the rebuildable index, not in filename prefixes.

---

## 4. `session.json` Schema

Every session folder should contain a `session.json`.

### 4.1 Common Fields

```json
{
  "schema_version": 1,
  "session_id": "unique-session-id",
  "session_type": "session_type_here",
  "display_name": "Human-readable session name",
  "created_at": "2026-07-04T09:00:00+10:00",
  "updated_at": "2026-07-04T12:00:00+10:00",
  "session_start": "2026-07-04T11:50:00+10:00",
  "session_end": null,
  "sort_key": "2026-07-04T11:50:00+10:00",
  "tags": [],
  "notes_file": "notes.md",
  "files": []
}
```

### 4.2 Manual Folder Discovery

If the app scans the archive and finds a folder without `session.json`, it should offer to recognise it as a session.

Default generated metadata:

```json
{
  "schema_version": 1,
  "session_id": "generated-stable-id",
  "session_type": "general_session",
  "display_name": "Folder_Name_As_Session_Name",
  "created_at": "time_metadata_was_created",
  "updated_at": "time_metadata_was_created",
  "session_start": null,
  "session_end": null,
  "sort_key": null,
  "tags": [],
  "notes_file": "notes.md",
  "files": []
}
```

The user can then enrich the metadata with event, match, robot, notes, tags, and file kinds.

This makes manual folder imports first-class rather than a workaround.

### 4.3 Session Types

Recommended initial session types:

```text
competition_event
official_match
practice_match
replay
workshop_session
tuning_session
debug_session
test_session
general_session
other
```

The app should allow adding more session types later without breaking older archives.

---

## 5. Example `session.json` Files

### 5.1 Competition Event Session

```json
{
  "schema_version": 1,
  "session_id": "apoc26",
  "session_type": "competition_event",
  "display_name": "APOC26",
  "created_at": "2026-07-04T09:00:00+10:00",
  "updated_at": "2026-07-04T09:42:00+10:00",

  "event": {
    "source": "FTCScout",
    "season": 2026,
    "display_code": "APOC26",
    "ftcscout_code": "apoc26",
    "name": "Australian Pacific Open Championship 2026",
    "last_synced": "2026-07-04T09:42:00+10:00",
    "has_matches": true
  },

  "teams": [12345],
  "tags": ["competition", "ftc"],
  "notes_file": "notes.md",
  "files": []
}
```

### 5.2 Official Match Session

```json
{
  "schema_version": 1,
  "session_id": "apoc26-q4",
  "session_type": "official_match",
  "display_name": "Q4 Blue B2",
  "created_at": "2026-07-04T11:58:00+10:00",
  "updated_at": "2026-07-04T12:02:00+10:00",

  "match": {
    "source": "FTCScout",
    "label": "Q4",
    "type": "qualification",
    "number": 4,
    "alliance": "blue",
    "station": "B2",
    "team_number": 12345
  },

  "tags": ["qualifying", "blue"],
  "notes_file": "notes.md",

  "files": [
    {
      "filename": "AutoOpMode_log_20260704_115005_104.rlog",
      "kind": "auto_log",
      "source": "control_hub",
      "remote_path": "/sdcard/FIRST/SpiderKit/AutoOpMode_log_20260704_115005_104.rlog",
      "imported_at": "2026-07-04T11:58:40+10:00",
      "original_filename": "AutoOpMode_log_20260704_115005_104.rlog",
      "file_size_bytes": 8412032
    },
    {
      "filename": "TeleOp_log_20260704_115327_882.rlog",
      "kind": "teleop_log",
      "source": "control_hub",
      "remote_path": "/sdcard/FIRST/SpiderKit/TeleOp_log_20260704_115327_882.rlog",
      "imported_at": "2026-07-04T11:59:10+10:00",
      "original_filename": "TeleOp_log_20260704_115327_882.rlog",
      "file_size_bytes": 9120341
    }
  ]
}
```

### 5.3 Custom Tuning Session Inside a Competition

```json
{
  "schema_version": 1,
  "session_id": "apoc26-drivebase-tuning-after-q4",
  "session_type": "tuning_session",
  "display_name": "Drivebase tuning after Q4",
  "created_at": "2026-07-04T12:15:00+10:00",
  "updated_at": "2026-07-04T12:20:00+10:00",

  "tags": ["swerve", "drivebase", "heading-pid"],
  "notes_file": "notes.md",

  "files": [
    {
      "filename": "DriveTest_log_20260704_121552_901.rlog",
      "kind": "tuning_log",
      "source": "control_hub",
      "remote_path": "/sdcard/FIRST/SpiderKit/DriveTest_log_20260704_121552_901.rlog",
      "imported_at": "2026-07-04T12:18:00+10:00",
      "original_filename": "DriveTest_log_20260704_121552_901.rlog",
      "file_size_bytes": 4021120
    }
  ]
}
```

### 5.4 General Workshop Session

```json
{
  "schema_version": 1,
  "session_id": "2026-07-08-workshop-testing",
  "session_type": "workshop_session",
  "display_name": "2026-07-08 Workshop Testing",
  "created_at": "2026-07-08T18:30:00+10:00",
  "updated_at": "2026-07-08T20:15:00+10:00",

  "session": {
    "date": "2026-07-08",
    "location": "workshop",
    "robot": "2026 Comp Bot"
  },

  "tags": ["workshop", "testing"],
  "notes_file": "notes.md",
  "files": []
}
```

---

## 6. File Kinds

Imported files should be classified by `kind`.

Recommended initial file kinds:

```text
auto_log
teleop_log
match_log
practice_log
tuning_log
debug_log
crash_log
test_log
video
screenshot
advantage_scope_layout
notes
other
```

The app can guess file kind from filename, but the user must be able to override it.

Examples:

```text
AutoOpMode_log_...        -> auto_log
TeleOp_log_...            -> teleop_log
BlueOpMode_log_...        -> match_log or teleop_log
LocalizationTest_log_...  -> tuning_log or test_log
DriveTest_log_...         -> tuning_log
crash_...txt              -> crash_log
```

---

## 7. ADB Integration

### 7.1 Device Detection

The app should detect connected ADB devices.

Equivalent command:

```bash
adb devices
```

The UI should show:

```text
ADB: connected
Device: Control Hub
```

or:

```text
ADB: not connected
```

### 7.2 RLOG Discovery

The app should browse `.rlog` files on the Control Hub.

Expected path:

```text
/sdcard/FIRST/SpiderKit
```

Possible commands:

```bash
adb shell ls -l /sdcard/FIRST/SpiderKit
```

or, if supported:

```bash
adb shell find /sdcard/FIRST/SpiderKit -name "*.rlog" -type f
```

The app should be tolerant of Android shell differences.

### 7.3 RLOG Metadata

The app should display:

- Filename
- Parsed opmode name
- Parsed timestamp, if present in filename
- File size
- Remote path
- Import status
- Existing destination session, if already imported

Example filename:

```text
BlueOpMode_log_20260704_115005_104.rlog
```

Parsed metadata:

```json
{
  "opmode": "BlueOpMode",
  "date": "2026-07-04",
  "time": "11:50:05.104"
}
```

### 7.4 Importing Files

Equivalent command:

```bash
adb pull /sdcard/FIRST/SpiderKit/BlueOpMode_log_20260704_115005_104.rlog ./FTCLogArchive/2026/APOC26/Q4_Blue_B2/
```

The app should:

1. Copy the file into the selected session folder.
2. Add an entry to that session’s `session.json`.
3. Update the global index.
4. Mark the remote file as imported in the UI.

The app should not rename or delete files on the Control Hub by default.

---

## 8. FTCScout Integration

### 8.1 Purpose

FTCScout should be used to fetch official event and match data when internet is available.

The app must still work offline.

FTCScout data is a convenience and a source of official match structure, not the source of truth for the local archive.

### 8.2 Cached Data

The app should cache:

- Event metadata
- Team list
- Official matches
- Selected team’s match appearances
- Alliance colour
- Station
- Match labels and numbers

### 8.3 Update Behaviour

The app should provide:

```text
[Update from FTCScout]
```

This should:

- Update competition event metadata.
- Create missing official match child sessions.
- Update match details such as alliance, station, and match number.
- Preserve local notes.
- Preserve imported files.
- Preserve custom child sessions.
- Preserve user-created tags and annotations.

Remote FTCScout data is replaceable. Local archive data is user-owned.

### 8.4 Offline Behaviour

The app should support this workflow:

```text
Before event:
  Connect to internet.
  Search/select FTCScout event.
  Select team number.
  Sync event and match data.

At event:
  Connect to Control Hub over ADB.
  Use cached event/match data.
  Import logs into official or custom sessions.

After event:
  Optionally reconnect to internet.
  Update FTCScout data again.
```

The app should assume that ADB connection and internet connection may be mutually exclusive, especially when connected to the Control Hub Wi-Fi network.

---

## 9. Competition Workflow

### 9.1 Event Setup

The user should be able to:

1. Select season.
2. Search FTCScout events.
3. Select event.
4. Enter/select team number.
5. Sync official match list.
6. Create a local competition session.

Example root:

```text
FTCLogArchive/2026/APOC26/
```

### 9.2 Match List UI

The UI should present the official matches for the selected team.

Example:

```text
APOC26 — Team 12345

Q4    Blue B2    2 logs
Q9    Red R1     no logs
Q17   Blue B3    no logs
Q23   Red R2     no logs
```

Each row should support:

```text
[Import latest matching alliance log]
[Import latest log]
[Choose log...]
[Open session]
[Add note]
```

### 9.3 Importing Multiple Logs to One Match

A match session can contain multiple logs.

Example:

```text
Q4 Blue B2

Files:
  AutoOpMode_log_20260704_115005_104.rlog     auto_log
  TeleOp_log_20260704_115327_882.rlog         teleop_log
  crash_20260704_115401.txt                   crash_log
```

The import action should append to the session, not replace the previous log.

### 9.4 Custom Sessions During a Competition

The user should be able to create custom sessions between official matches.

Examples:

```text
Practice field run
Drivebase tuning after Q4
Auto path test before Q9
Replay of Q4
Pit debug session
```

UI concept:

```text
Q4 Blue B2
+ Create custom session here
Q9 Red R1
+ Create custom session here
Q17 Blue B3
```

A custom session behaves exactly like an official match session: it has a folder, a `session.json`, notes, tags, and imported files.

---

## 10. General / Date-Based Workflow

When not at a competition, the app should be hub-file-browser-first.

### 10.1 General UI

The app should display the logs currently on the Control Hub.

Example:

```text
Control Hub logs

Date        Time       Opmode              File                                      Status
2026-07-04  11:50:05   BlueOpMode          BlueOpMode_log_20260704_115005_104.rlog   Imported
2026-07-04  12:02:11   LocalizationTest    LocalizationTest_log_20260704_120211.rlog Not imported
2026-07-04  12:18:42   ShooterTuning       ShooterTuning_log_20260704_121842.rlog    Not imported
2026-07-03  22:44:10   DriveTest           DriveTest_log_20260703_224410.rlog        Not imported
```

Actions:

```text
[Import selected]
[Import latest]
[Import all from this date]
[Create session from selected]
[Annotate]
[Ignore]
[Open copied folder]
```

### 10.2 General Folder Import

Default quick import path:

```text
FTCLogArchive/
  2026/
    2026-07-04/
      115005_BlueOpMode/
        session.json
        BlueOpMode_log_20260704_115005_104.rlog
```

Session-based import path:

```text
FTCLogArchive/
  2026/
    2026-07-04_Drivebase_Tuning/
      session.json
      notes.md
      DriveTest_log_20260704_120552_901.rlog
      LocalizationTest_log_20260704_121842_330.rlog
```

---

## 11. UI Design

### 11.1 Main Layout

Recommended layout:

```text
┌─────────────────────────────────────────────────────────────┐
│ Toolbar: Mode | ADB Status | Internet Status | Archive Root │
├───────────────────────────────┬─────────────────────────────┤
│ Session Tree / Event Timeline │ Hub Logs / Session Details   │
│                               │                             │
│ APOC26                        │ Selected session: Q4 Blue B2 │
│   Q4 Blue B2                  │ Files:                      │
│   Drivebase Tuning After Q4   │   AutoOpMode...rlog         │
│   Q9 Red R1                   │   TeleOp...rlog             │
│                               │                             │
│ General                       │ Available Hub Logs:         │
│   2026-07-08 Workshop Testing │   BlueOpMode...rlog         │
└───────────────────────────────┴─────────────────────────────┘
```

### 11.2 Modes

The app should support two top-level organising modes:

```text
Competition Event
General / Date Import
```

Internally, both modes operate on the same session tree model.

### 11.3 Session Tree

The session tree should show:

- Year
- Competition sessions
- General sessions
- Child sessions
- Number of imported files
- Missing/complete indicators

Example:

```text
FTC Log Archive
  2026
    APOC26
      Q4 Blue B2                  2 logs
      Drivebase tuning after Q4   1 log
      Q9 Red R1                   no logs
    2026-07-08 Workshop Testing
      Shooter PID                 1 log
      Localization Debug          1 log
```

### 11.4 Hub Logs Pane

The hub logs pane should show:

- Remote logs on the Control Hub
- Whether each log has already been imported
- Where it was imported
- Whether it has been ignored

Example statuses:

```text
Not imported
Imported → APOC26 / Q4 Blue B2
Imported → General / 2026-07-08 Workshop Testing / Shooter PID
Ignored
```

### 11.5 Import Interactions

The app should support:

- Click session → import latest log
- Click session → choose log
- Drag remote log onto session
- Select multiple remote logs → import into selected session
- Right-click remote log → import/annotate/ignore
- Right-click session → create child session/open folder/edit metadata

---

## 12. Filtering and Search

The app should index session metadata and allow filtering.

### 12.1 Filters

Useful filters:

```text
Session type:
  Competition event
  Official match
  Practice match
  Workshop session
  Tuning session
  Debug session

Contains file kind:
  Auto log
  TeleOp log
  Crash log
  Video
  Screenshot

Event:
  APOC26
  NSW Qualifier
  General

Team:
  12345
  22503
  Test robot

Alliance:
  Blue
  Red
  N/A

Tags:
  localization
  shooter
  swerve
  turret
  vision
```

### 12.2 Search Examples

The UI should eventually support searches like:

```text
All official matches missing teleop logs
All sessions tagged localization
All sessions containing crash logs
All logs from APOC26
All blue alliance matches
All workshop sessions from July 2026
All imported but unannotated logs
```

---

## 13. Global Index

The folder structure and `session.json` files are the source of truth.

However, the app should maintain a global index for fast browsing and filtering.

Recommended:

```text
FTCLogArchive/.logvue/index.sqlite
```

The index should be rebuildable by scanning the archive and reading all `session.json` files.

Required behaviour:

```text
If .logvue/index.sqlite is missing:
  Rebuild index from session folders.

If session.json changes:
  Update index.

If archive is copied to another computer:
  App can rebuild index.
```

The app should never require a hidden central database to make the archive meaningful.

---

## 14. Duplicate and Import Tracking

The app should avoid accidental duplicate imports.

A remote file identity can be based on:

```text
remote_path
original_filename
file_size_bytes
parsed_timestamp
```

Optional later improvement:

```text
file_hash
```

The app should show when a remote log has already been imported:

```text
Imported → APOC26 / Q4 Blue B2
```

If the same file is imported again intentionally, the app should warn the user.

Duplicate behaviour options:

```text
Cancel
Import another copy
Link existing imported file
Move/reassign to different session
```

---

## 15. Ignored Logs

Not every `.rlog` needs to be imported.

The app should allow a remote log to be marked as ignored.

Ignored logs should:

- Disappear from the default “unimported logs” view.
- Remain visible with “Show ignored logs”.
- Be reversible.

Ignored log state can live in the global index/cache, not necessarily in the archive.

---

## 16. Notes

Each session should have an optional `notes.md`.

Example:

```markdown
# Q4 Blue B2

Auto worked. TeleOp was mostly fine.

Issues:
- Turret oscillated near endgame.
- Localization jumped after contact near the wall.

Follow-up:
- Check vision residuals.
- Compare auto and teleop heading drift.
```

The UI should make notes easy to edit.

---

## 17. Future Video Support

The session model should support future video or media import.

Example session folder:

```text
Q4_Blue_B2/
  session.json
  notes.md
  AutoOpMode_log_20260704_115005_104.rlog
  TeleOp_log_20260704_115327_882.rlog
  field_camera.mp4
  driver_station_video.mp4
```

Example media metadata:

```json
{
  "filename": "field_camera.mp4",
  "kind": "video",
  "source": "usb_camera",
  "time_source": "manual_sync",
  "offset_seconds": 1.42,
  "imported_at": "2026-07-04T12:05:00+10:00"
}
```

This keeps the archive compatible with future AdvantageScope/video workflows.

---

## 18. MVP Scope

The first usable version should include:

1. ADB device detection.
2. Browsing `.rlog` files from `/sdcard/FIRST/SpiderKit`.
3. Parsing filename timestamps and opmode names.
4. Local archive root selection.
5. Creating session folders.
6. Creating/editing `session.json`.
7. Importing one or more logs into a session.
8. Showing imported/not imported status for hub logs.
9. General/date-based import workflow.
10. Basic competition session workflow with manually created match/session folders.
11. Basic filtering by session type, tag, and file kind.
12. Rebuildable local index.

FTCScout integration can be added after the local archive model is working.

---

## 19. Post-MVP Features

Recommended later features:

1. FTCScout event search.
2. FTCScout event sync/update.
3. Automatic creation of official match child sessions for a selected team.
4. One-click import latest matching alliance log into a match session.
5. Drag/drop hub logs into sessions.
6. Notes editor.
7. Crash log import.
8. AdvantageScope “Open log” shortcut.
9. Video import and sync metadata.
10. More powerful search/filter UI.
11. Export session folder as `.zip`.
12. Archive validation and repair tool.

---

## 20. Design Principles

1. **Folders are the data structure.**
   - A session is a folder.
   - The folder name is the session name.
   - Metadata lives in `session.json`.
   - Notes live in `notes.md`.
   - Files live beside their metadata.
   - Folder names should stay natural and manually browsable; rich structure belongs in sidecar metadata.

2. **Everything is a session.**
   - Competition events, official matches, practice matches, tuning runs, and workshop tests all use the same model.

3. **FTCScout is helpful, not mandatory.**
   - Sync when online.
   - Cache for offline use.
   - Preserve local user data.

4. **One session can contain many logs.**
   - Auto, TeleOp, crash, replay, and tuning logs can all belong to one match/session.

5. **Local annotations are authoritative.**
   - Updating FTCScout data must not overwrite user notes, tags, imported files, or custom sessions.

6. **The archive should be portable.**
   - Copying a session folder should preserve its meaning.
   - The global index should be rebuildable from the folder tree.

7. **The UI should make the common action one click.**
   - At competition: import latest log into the selected match/session.
   - At home: import selected logs into a date/session folder.

---

## 21. Suggested Tech Stack

Recommended initial implementation:

```text
Python
PySide6 / Qt
SQLite
subprocess-based ADB wrapper
```

Suggested module layout:

```text
ftc-log-organiser/
  app.py
  adb_client.py
  ftcscout_client.py
  archive/
    session_model.py
    session_store.py
    index_store.py
    schema.py
  ui/
    main_window.py
    session_tree.py
    hub_log_table.py
    session_details.py
  tests/
```

### 21.1 Key Classes

```python
class Session:
    path: Path
    metadata: SessionMetadata
    child_sessions: list["Session"]
    files: list[SessionFile]
```

```python
class SessionFile:
    filename: str
    kind: str
    source: str
    imported_at: datetime
    remote_path: str | None
    original_filename: str | None
    file_size_bytes: int | None
```

```python
class HubLog:
    remote_path: str
    filename: str
    opmode: str | None
    parsed_timestamp: datetime | None
    file_size_bytes: int | None
    import_status: str
```

---

## 22. Open Questions

1. Should session ordering be based on `session_start`, `sort_key`, explicit manual order fields, or a combination?
2. Should copied `.rlog` files keep their original filename always, or should the app optionally prefix them?
3. Should ignored remote logs be stored globally only, or should ignored markers be exportable with an archive?
4. Should sessions support multiple teams in one archive view?
5. Should FTCScout codes and local display codes be separate fields?
6. Should a session be allowed to reference a file outside its folder, or must files always be physically copied into the session folder?
7. Should the app support deleting/moving remote logs from the Control Hub, or remain import-only by default?

Recommended defaults:

- Do not use folder sequence prefixes for ordering. Use natural folder names, and store ordering/timestamps in `session.json` and the index.
- Keep original `.rlog` filenames.
- Store ignored remote logs in the global app index/cache.
- Support multiple teams later, but optimise MVP for one selected team.
- Keep FTCScout code and local display code separate.
- Physically copy files into session folders.
- Do not delete or rename files on the Control Hub by default.
