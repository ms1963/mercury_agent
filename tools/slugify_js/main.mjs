// Example Mercury polyglot tool: JSON args on stdin, plain text on stdout.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { text = '' } = JSON.parse(input || '{}');
const slug = String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
process.stdout.write(slug);
