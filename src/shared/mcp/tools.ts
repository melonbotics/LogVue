import { z } from 'zod'
import { SESSION_TYPES } from '../constants/sessionTypes'

export const LOGVUE_MCP_INSTRUCTIONS =
  'Use these tools only for live Control Hub access and LogVue-managed imports. Read, search, and edit archive files such as session.json and notes.md directly through the filesystem; LogVue watches the archive and refreshes its UI automatically. Robot OpMode control is operator-gated: call get_robot_status immediately before init or start and pass its fresh nonce unchanged. Init is asynchronous; after it is accepted, poll status until the exact requested OpMode reports INIT, then start with the nonce from that confirming status. Stop does not use a nonce.'

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
  },
  getRobotStatus: {
    name: 'get_robot_status',
    config: {
      title: 'Get robot OpMode status',
      description:
        'Return current robot and OpMode state plus a fresh, short-lived nonce. Call this immediately before each init or start request; stop does not use a nonce.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, openWorldHint: true }
    }
  },
  controlOpMode: {
    name: 'control_opmode',
    config: {
      title: 'Control a robot OpMode',
      description:
        'Queue initialization or start an FTC OpMode using the fresh nonce returned by get_robot_status, or stop the exact lease-owned OpMode without a nonce. After init is accepted, poll status until the exact OpMode reports INIT before starting it with that confirming status nonce. Agent OpMode control must be enabled by the operator in LogVue and armed on the robot.',
      inputSchema: z
        .object({
          nonce: z
            .string()
            .min(16)
            .max(1024)
            .optional()
            .describe('Fresh nonce returned by get_robot_status; required for init/start and omitted for stop'),
          action: z.enum(['init', 'start', 'stop']).describe('Requested FTC OpMode transition'),
          opModeName: z.string().trim().min(1).max(256).optional().describe('Exact registered OpMode name')
        })
        .superRefine((value, ctx) => {
          if (value.action !== 'stop' && !value.nonce) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nonce'],
              message: 'nonce is required when action is init or start'
            })
          }
          if (value.action === 'stop' && value.nonce !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['nonce'],
              message: 'nonce must be omitted when action is stop'
            })
          }
          if (value.action === 'init' && !value.opModeName) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['opModeName'],
              message: 'opModeName is required when action is init'
            })
          }
          if (value.action !== 'init' && value.opModeName !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['opModeName'],
              message: 'opModeName must be omitted when action is start or stop'
            })
          }
        }),
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }
  }
} as const
