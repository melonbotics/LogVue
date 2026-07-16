import { z } from 'zod'
import { SESSION_TYPES } from '../constants/sessionTypes'

export const LOGVUE_MCP_INSTRUCTIONS =
  'Use these tools only for live Control Hub access and LogVue-managed imports. Read, search, and edit archive files such as session.json and notes.md directly through the filesystem; LogVue watches the archive and refreshes its UI automatically.'

/**
 * The bridge and the Electron-hosted server both advertise this contract. Keeping
 * it in Electron-independent shared code lets the bridge initialize while LogVue is
 * offline without allowing the two tool lists to drift.
 */
export const LOGVUE_MCP_TOOLS = {
  getStatus: {
    name: 'get_status',
    config: {
      title: 'Get LogVue status',
      description: 'Return the configured archive, MCP endpoint, and current ADB connection status.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    }
  },
  listHubLogs: {
    name: 'list_hub_logs',
    config: {
      title: 'List Control Hub logs',
      description: 'List the newest RLOG files available from the configured Control Hub or folder source.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20).describe('Maximum logs to return, newest first')
      }),
      annotations: { readOnlyHint: true }
    }
  },
  createSession: {
    name: 'create_session',
    config: {
      title: 'Create an archive session',
      description:
        'Create a schema-valid session folder through LogVue. parentPath may be archive-relative, Windows absolute, or a WSL /mnt/<drive>/... path; omit it to create at the archive root.',
      inputSchema: z.object({
        parentPath: z.string().optional().describe('Parent folder; defaults to the configured archive root'),
        displayName: z.string().trim().min(1).describe('Human-readable session name'),
        sessionType: z.enum(SESSION_TYPES).default('general_session').describe('LogVue session type')
      })
    }
  },
  importHubLog: {
    name: 'import_hub_log',
    config: {
      title: 'Import a Control Hub log',
      description:
        'Pull one available Control Hub RLOG into an existing session. The import appears in LogVue Activity and updates the index.',
      inputSchema: z.object({
        remotePath: z.string().min(1).describe('Exact remote_path returned by list_hub_logs'),
        sessionPath: z
          .string()
          .min(1)
          .describe('Existing session as an archive-relative, Windows absolute, or WSL /mnt/<drive>/... path'),
        force: z.boolean().optional().describe('Import another copy when LogVue detects a duplicate')
      })
    }
  }
} as const
