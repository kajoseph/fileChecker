const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const assert = require('assert');
const readline = require('readline');

function Usage(msg) {
    if (msg) {
        console.log(msg, '\n');
    }

    console.log('Usage: node index.js <command> [...args]');
    console.log('');
    console.log('Commands:')
    console.log('   sync <workDir>')
    console.log('   init-compare <local|remote> <workDir> [mismatches.json]')
    console.log('   compare <local file> <remote file>');
    process.exit();
}

process.on('uncaughtException', Usage);

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    Usage();
};

const escape = (str) => str.replace(/\s/g, '\\ ');

if (process.argv[2] == 'init-compare') {
    if (!process.argv[3]) {
        throw new Error('Need to specify remote or local\n\nUsage: node ./index.js init remote|local');
    }

    if (!process.argv[4] || !fs.existsSync(process.argv[4])) {
        throw new Error('Invalid workDir specified');
    }
    const workDir = path.resolve(process.argv[4]);

    let mismatches;
    if (process.argv[3] == 'remote' && process.argv[5]) {
        try {
            mismatches = require(process.argv[5]);
        } catch (err) {
            console.log('Error requiring mismatches file: ' + process.argv[5]);
            throw err;
        }
    }

    // const _baseDir = '/Users/kajoseph/Desktop/Dashcam';
    const outputFile = `./output-${process.argv[3]}-${workDir.split('/').reverse()[0]}.js`;

    function readDir(baseDir) {
        const dirContents = fs.readdirSync(baseDir);

        const filenames = [];

        for (const item of dirContents) {
            if (item == '.DS_Store' || item[0] == '.') {
                continue;
            }
            const fullPath = path.join(baseDir, item);
            const stat = fs.lstatSync(fullPath);
            if (stat.isDirectory()) {
                readDir(fullPath);
            } else {
                console.log(fullPath.replace(workDir, ''));
                const out = execSync('shasum -a 256 "' + fullPath + '"').toString();
                const checksum = out.split(' ')[0];
                fs.appendFileSync(outputFile, `\n\t"${fullPath.replace(workDir, '')}": "${checksum}",`);
            }
        }
        return filenames;
    }

    if (!mismatches) {
        fs.writeFileSync(outputFile, 'module.exports = {');
        const a = readDir(workDir);
        // a.sort((a, b) => a - b);
        fs.appendFileSync(outputFile, '\n}');
    } else {
        const output = require(outputFile);
        for (const mismatch of mismatches) {
            const out = execSync('shasum -a 256 "' + path.join(workDir, mismatch) + '"').toString();
            const checksum = out.split(' ')[0];
            assert(output[mismatch], 'The existing output[mismatch] does not exist in the output file');
            output[mismatch] = checksum;
            console.log(mismatch, checksum);
        }
        fs.writeFileSync(outputFile, 'module.exports = ' + JSON.stringify(output, null, 2));
    }

} else if (process.argv[2] == 'compare') {
    if (!process.argv[3]) {
        throw new Error('Missing local file name');
    }
    if (!process.argv[4]) {
        throw new Error('Missing remote file name');
    }
    const localFileName = process.argv[3]; // './output-local-<something>.js'
    const remoteFileName = process.argv[4];
    // const suffix = localFileName.split('-').slice(2).join('-').replace(/.js$/gi, '');
    // const remoteFileName = `./output-local${suffix ? '-' + suffix : ''}.js`;
    if (!fs.existsSync(localFileName) || !fs.existsSync(remoteFileName)) {
        throw new Error('Missing output file(s)');
    }
    const remote = require(remoteFileName);
    const local = require(localFileName);
    const folder = localFileName.replace('output-local-', '').replace('.js', '').replace(/\s/g, '\\ ');

    if (Object.keys(local).length !== Object.keys(remote).length) {
        throw new Error(`Remote is missing some entries. Local: ${Object.keys(local).length}, remote: ${Object.keys(remote).length}`);
    }

    const mismatches = [];

    const rl = readline.createInterface(process.stdin, process.stdout);
    rl.question('Would you like to re-sync (s) or re-check (c) mismatches? (s/c/sc/n)', function(ans) {
        let dirtyRemote = false;
        for (const key of Object.keys(local)) {
            if (!remote[key]) {
                console.log('MISSING: ', key);
            }
    
            if (local[key] != remote[key]) {
                console.log(`${key} -- Local: ${local[key]} -- Remote: ${remote[key]}`);
                mismatches.push(key);
                if (ans.includes('s')) {
                    const cmd = `scp -i /Users/kajoseph/.ssh/id_rsa /Users/kajoseph/Desktop/Dashcam/${folder}${key.replace(/\s/g, '\\ ')} kjoseph@192.168.50.164:/mnt/vol1/Dashcam/${folder}${key.replace(/\s/g, '\\ ')}`;
                    // console.log(cmd);
                    execSync(cmd, {
                        stdio: 'inherit'
                    });
                }
                if (ans.includes('c')) {
                    const out = execSync(`ssh -i /Users/kajoseph/.ssh/id_rsa kjoseph@192.168.50.164 "sha256sum /mnt/vol1/Dashcam/${folder}${key.replace(/\s/g, '\\ ')}"`);
                    const checksum = out.toString().split(' ')[0];
                    remote[key] = checksum;
                    dirtyRemote = true;
                    if (checksum !== local[key]) {
                        console.log(`${key} resync failed.\n\t${checksum} does not match ${local[key]}`);
                    }
                }
            }
            // mismatches[key];
        }
    
        if (Object.keys(mismatches).length > 0) {
            fs.writeFileSync('mismatches.json', JSON.stringify(mismatches, null, 2));
            console.log('Done. Mismatches written to mismatches.json');
        } else {
            console.log('No mismatches found!')
        }

        if (dirtyRemote) {
            fs.writeFileSync(remoteFileName, `module.exports = ${JSON.stringify(remote, null, 2)}`);
        }

        rl.close();
    });
} else if (process.argv[2] == 'sync') {
    if (!process.argv[3]) {
        Usage('Sync workDir is missing');
    }
    const workDir = process.argv[3];
    if (!fs.existsSync(workDir)) {
        throw new Error('Invalid workDir: ' + workDir);
    }

    let started = false;
    let done = {};
    
    function readDir(baseDir, outputFile, startAt) {
        const dirContents = fs.readdirSync(baseDir);
        const filenames = [];

        for (const item of dirContents) {
            if (item == '.DS_Store') {
                continue;
            }
            const fullPath = path.join(baseDir, item);
            const stat = fs.lstatSync(fullPath);
            const relPathName = fullPath.replace(workDir, ''); // with item
            const relPath = relPathName.replace(item, ''); // without item

            if (stat.isDirectory()) {
                execSync(`ssh -i /Users/kajoseph/.ssh/id_rsa kjoseph@192.168.50.164 "mkdir -p /mnt/vol1/Dashcam${escape(relPathName)}"`);
                readDir(fullPath, outputFile, startAt);
            } else {
                if (done[relPathName]) {
                    continue;
                }
                console.log(relPathName);
                
                try {
                    execSync(`scp -i /Users/kajoseph/.ssh/id_rsa /Users/kajoseph/Desktop/Dashcam${escape(relPathName)} kjoseph@192.168.50.164:/mnt/vol1/Dashcam${escape(relPathName)}`, {
                    // execSync(`rsync --progress -havu -e "ssh -i /Users/kajoseph/.ssh/id_rsa" /Users/kajoseph/Desktop/Dashcam${escape(relPathName)} kjoseph@192.168.50.164:/mnt/vol1/Dashcam${escape(relPathName)}`, {
                        stdio: 'inherit'
                    });
                } catch (err) {
                    execSync('sleep 60'); // wait 1 minute to reconnect
                    execSync(`scp -i /Users/kajoseph/.ssh/id_rsa /Users/kajoseph/Desktop/Dashcam${escape(relPathName)} kjoseph@192.168.50.164:/mnt/vol1/Dashcam${escape(relPathName)}`, {
                    // execSync(`rsync --progress -havu -e "ssh -i /Users/kajoseph/.ssh/id_rsa" /Users/kajoseph/Desktop/Dashcam${escape(relPathName)} kjoseph@192.168.50.164:/mnt/vol1/Dashcam${escape(relPathName)}`, {
                        stdio: 'inherit'
                    });
                }
                const out = execSync('shasum -a 256 "' + fullPath + '"').toString();
                const checksum = out.split(' ')[0];
                fs.appendFileSync(outputFile, `\n\t"${relPathName}": "${checksum}",`);
            }
        }
        return filenames;
    }

    function getLastSync(filename) {
        try {
            const a = require(filename);
            done = a;
            return Object.keys(a).reverse()[0]
        } catch (err) {
            let a = fs.readFileSync(filename).toString();
            if (a.endsWith(',')) {
                done = JSON.parse(a.replace('module.exports = ', '').slice(0, -1) + '}')
            }
            a = a.split('\n').reverse();
            for (const b of a) {
                if (b.trim() && b !== 'module.exports = {') {
                    return b.split(':')[0].trim().replace(/"/g, '');
                }
            }
            return false;
        }
    }

    const dirContents = fs.readdirSync(workDir);
    for (const item of dirContents) {
        if (item == '.DS_Store') {
            continue;
        }
        if (item[0] == '_') {
            continue;
        }
        const outputFile = `sync-${item}.js`;
        if (!fs.existsSync(outputFile)) {
            fs.writeFileSync(outputFile, 'module.exports = {');
        }
        const fullItem = path.join(workDir, item);
        const startAt = getLastSync(outputFile);
        started = false;
        readDir(fullItem, outputFile, startAt);
        fs.appendFileSync(outputFile, '\n};')
    }
} else {
    console.log('No args given');
    Usage();
}
