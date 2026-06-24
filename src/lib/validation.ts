/**
 * Forgiving input validation (Postel's Law): accept generously, normalise, and
 * only reject what truly can't be used — with clear, friendly field messages.
 * Hand-rolled to avoid an extra dependency.
 */

export interface FieldError {
  field: string;
  message: string;
}

export interface ContactInput {
  name: string;
  organisation: string;
  role: string;
  email: string;
  message: string;
}

export interface SubscribeInput {
  email: string;
}

// Pragmatic email check — intentionally permissive (Postel's Law).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export function validateContact(raw: Record<string, unknown>): {
  data?: ContactInput;
  errors: FieldError[];
} {
  const errors: FieldError[] = [];

  const name = str(raw.name);
  const organisation = str(raw.organisation);
  const role = str(raw.role);
  const email = str(raw.email).toLowerCase();
  const message = str(raw.message);

  if (name.length < 2) errors.push({ field: 'name', message: 'Please enter your name.' });
  if (!EMAIL_RE.test(email))
    errors.push({ field: 'email', message: 'Please enter a valid email address.' });
  if (message.length < 10)
    errors.push({
      field: 'message',
      message: 'Please add a little more detail (at least 10 characters).',
    });

  if (errors.length > 0) return { errors };

  // Normalise + clamp lengths defensively.
  return {
    data: {
      name: clamp(name, 200),
      organisation: clamp(organisation, 200),
      role: clamp(role, 120),
      email: clamp(email, 200),
      message: clamp(message, 5000),
    },
    errors: [],
  };
}

export function validateSubscribe(raw: Record<string, unknown>): {
  data?: SubscribeInput;
  errors: FieldError[];
} {
  const email = str(raw.email).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { errors: [{ field: 'email', message: 'Please enter a valid email address.' }] };
  }
  return { data: { email: clamp(email, 200) }, errors: [] };
}
