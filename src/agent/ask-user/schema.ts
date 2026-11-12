export interface UserQuestion {
  id: string;
  question: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface UserAnswer { id: string; selected: string[]; text?: string }
export type AskUserResult =
  | { status: 'answered'; answers: UserAnswer[] }
  | { status: 'cancelled' | 'expired' | 'unavailable'; reason: string };

export const ASK_USER_TIMEOUT_MS = 10 * 60 * 1000;
export const ASK_USER_INPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array', minItems: 1, maxItems: 5,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'question'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64 },
          question: { type: 'string', minLength: 1, maxLength: 4000 },
          multiSelect: { type: 'boolean' },
          options: {
            type: 'array', minItems: 2, maxItems: 5,
            items: {
              type: 'object', additionalProperties: false, required: ['label'],
              properties: {
                label: { type: 'string', minLength: 1, maxLength: 120 },
                description: { type: 'string', maxLength: 500 },
              },
            },
          },
        },
      },
    },
  },
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function parseQuestions(input: unknown): UserQuestion[] {
  if (!record(input) || Object.keys(input).some(k => k !== 'questions') ||
      !Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 5) {
    throw new Error('ask_user requires 1–5 questions');
  }
  const ids = new Set<string>();
  return input.questions.map(q => {
    if (!record(q) || Object.keys(q).some(k => !['id', 'question', 'options', 'multiSelect'].includes(k)) ||
        !text(q.id, 64) || !/^[A-Za-z0-9_-]+$/.test(q.id) || ids.has(q.id) || !text(q.question, 4000) ||
        (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean')) throw new Error('Invalid ask_user question');
    ids.add(q.id);
    if (q.options !== undefined) {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 5) throw new Error('Invalid ask_user options');
      const labels = new Set<string>();
      for (const o of q.options) {
        if (!record(o) || Object.keys(o).some(k => !['label', 'description'].includes(k)) || !text(o.label, 120) ||
            labels.has(o.label.trim()) || (o.description !== undefined && (typeof o.description !== 'string' || o.description.length > 500))) {
          throw new Error('Invalid or duplicate ask_user option');
        }
        labels.add(o.label.trim());
      }
    } else if (q.multiSelect) throw new Error('multiSelect requires options');
    return q as unknown as UserQuestion;
  });
}
