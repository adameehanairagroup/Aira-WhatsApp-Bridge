const fs = require('fs');
const path = require('path');

const COMMAND_FILE = path.join(__dirname, 'cmd.json');

const args = process.argv.slice(2);
const to = args[0];
const text = args.slice(1).join(' ');

if (!to || !text) {
    console.log('Usage: node bridge_send.js <number> <message>');
    process.exit(1);
}

const command = { to, text };

fs.writeFileSync(COMMAND_FILE, JSON.stringify(command));
console.log('🚀 Command sent to bridge!');
