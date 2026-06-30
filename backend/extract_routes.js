const fs = require('fs');
const path = require('path');

const indexFile = 'C:\\Users\\ENG-hussien\\Desktop\\skils inti\\.agent\\skills\\skills\\hdd-monitor\\backend\\index.js';
let content = fs.readFileSync(indexFile, 'utf8');

// A function to find the matching closing brace of a block
function getBlockEnd(str, start) {
    let open = 0;
    let i = start;
    while (i < str.length && str[i] !== '{') i++;
    for (; i < str.length; i++) {
        if (str[i] === '{') open++;
        if (str[i] === '}') {
            open--;
            if (open === 0) return i;
        }
    }
    return -1;
}

// We will find all app.get, app.post, app.put, app.delete calls
const routeRegex = /app\.(get|post|put|delete)\(['"](\/api\/.*?)['"]/g;
let match;
const allRoutes = [];

while ((match = routeRegex.exec(content)) !== null) {
    const method = match[1];
    const url = match[2];
    const startIndex = match.index;
    
    // We need to find the end of this app.get(...) block
    // It's usually ended by `);` after the closing brace of the callback.
    // Or if it's an inline arrow function without braces: `app.get('...', (req, res) => res.json(...));`
    
    // Find the nearest `);` after the route definition
    let endIndex = content.indexOf(');', startIndex);
    
    // BUT what if there's a block `{ ... }`?
    const blockEnd = getBlockEnd(content, startIndex);
    if (blockEnd !== -1 && blockEnd > endIndex) {
        // Find the `);` after the blockEnd
        endIndex = content.indexOf(');', blockEnd);
    }
    
    if (endIndex !== -1) {
        allRoutes.push({
            method,
            url,
            content: content.substring(startIndex, endIndex + 2),
            start: startIndex,
            end: endIndex + 2
        });
    }
}

// Sort routes by start index descending so we can delete them from bottom to top safely
allRoutes.sort((a, b) => b.start - a.start);

let apiRoutesStr = '';
let serviceRoutesStr = '';
let authUserRoutesStr = '';

for (const route of allRoutes) {
    // Modify the block to use 'router' instead of 'app'
    let routeStr = route.content.replace(/^app\./, 'router.');
    
    // Fix state references
    routeStr = routeStr
        .replace(/\bhosts\b/g, 'state.hosts')
        .replace(/\beventLog\b/g, 'state.eventLog')
        .replace(/\bbandwidthHistory\b/g, 'state.bandwidthHistory')
        .replace(/\bnetworkDevices\b/g, 'state.networkDevices')
        .replace(/\bsshConfigs\b/g, 'state.sshConfigs')
        .replace(/\balertThresholds\b/g, 'state.alertThresholds')
        .replace(/\bcurrentDisks\b/g, 'state.currentDisks')
        .replace(/state\.state\./g, 'state.'); // Just in case
    
    if (route.url.startsWith('/api/services')) {
        serviceRoutesStr = routeStr + '\n\n' + serviceRoutesStr;
        content = content.substring(0, route.start) + content.substring(route.end);
    } else if (route.url.startsWith('/api/auth/user')) {
        authUserRoutesStr = routeStr + '\n\n' + authUserRoutesStr;
        content = content.substring(0, route.start) + content.substring(route.end);
    } else if (route.url !== '/api/auth/login' && route.url !== '/api/auth/verify' && route.url !== '/api/auth/logout' && route.url !== '/api/auth/change-password') {
        // Standard API route
        apiRoutesStr = routeStr + '\n\n' + apiRoutesStr;
        content = content.substring(0, route.start) + content.substring(route.end);
    }
}

// Generate the new routes/api.js
const apiJsContent = `const express = require('express');
const router = express.Router();
const db = require('../database');
const state = require('../state');
const { verifyAdmin } = require('../middleware/auth');

${apiRoutesStr}

module.exports = router;
`;
fs.writeFileSync(path.join(__dirname, 'routes', 'api.js'), apiJsContent);

// Generate the new routes/services.js
const servicesJsContent = `const express = require('express');
const router = express.Router();
const db = require('../database');
const state = require('../state');

${serviceRoutesStr}

module.exports = router;
`;
fs.writeFileSync(path.join(__dirname, 'routes', 'services.js'), servicesJsContent);

// We need to append authUserRoutesStr to auth.js
if (authUserRoutesStr) {
    const authPath = path.join(__dirname, 'routes', 'auth.js');
    let authContent = fs.readFileSync(authPath, 'utf8');
    authContent = authContent.replace('module.exports = router;', authUserRoutesStr + '\nmodule.exports = router;');
    fs.writeFileSync(authPath, authContent);
}

fs.writeFileSync(indexFile, content);
console.log('✅ Successfully extracted all API Routes into separate router modules!');
