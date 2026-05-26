#!/usr/bin/env node
// Run this once: node server/generate-vapid.js
// Then paste the output into your .env file

const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('\nAdd these to your .env file:\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('\nDone!\n');
