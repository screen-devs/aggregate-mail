import { openSync, readSync, closeSync } from 'node:fs';
import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
const id = z.string().min(1).max(300);
const ids = z.array(id).max(200);
const timestamp = z.number().int().min(0).max(253402300799999);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return value >= '0001-01-01' && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const schemas = {
  'create-project': z.object({ requestId: z.uuid(), accountId: text, name: text, sourceMailIds: ids.min(1) }).strict(),
  'track-commitment': z.object({ requestId: z.uuid(), accountId: text, sourceMailId: id,
    text, reason: text, status: z.enum(['needs-reply', 'needs-work', 'waiting']),
    evidenceMailIds: ids.default([]), projectId: text.optional(), dueDate: date.optional(),
    dueAt: timestamp.optional(), followUpAt: timestamp.optional(),
  }).strict().refine((input) => input.dueDate === undefined || input.dueAt === undefined),
  // shortcut: plain-text draft content only; expand when attachments are in CLI scope.
  'propose-draft': z.object({ accountId: z.string().min(1), sourceMailId: z.string().optional(),
    content: z.object({ to: z.string().max(10000), cc: z.array(z.string().max(320)).max(100).optional(),
      subject: z.string().max(998), body: z.string().max(1000000),
      inReplyTo: z.string().max(998).optional(), threadId: z.string().max(100).optional(),
      references: z.array(z.string().max(998)).max(100).optional(),
    }).strict(),
  }).strict(),
};

export function fileInput(command, filename) {
  // Bound reads even for pipes or files that grow while being read.
  const fd = openSync(filename, 'r');
  try {
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    let size = 0, count;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null))) size += count;
    if (size === buffer.length) throw new Error();
    return schemas[command].parse(JSON.parse(buffer.subarray(0, size).toString('utf8')));
  } finally { closeSync(fd); }
}
