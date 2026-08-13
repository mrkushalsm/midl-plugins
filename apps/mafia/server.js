import socket from 'midl/socket';

// The host runtime has no timer primitives (no setTimeout/setInterval) and issues a
// brand-new clientId on every (re)connect, so phases are resolved by player actions
// (not clocks) and reconnects are matched via a client-generated `token` in the join
// payload, kept private to the owning client, rather than by clientId.

const ROLES = {
    MAFIA: 'mafia',
    VILLAGER: 'villager',
    DOCTOR: 'doctor',
    DETECTIVE: 'detective'
};

const ROLE_INFO = {
    mafia: { name: 'Mafia', team: 'mafia', description: 'Each night, work with your fellow Mafia to secretly eliminate a Town member. Win when Mafia equal or outnumber the Town.' },
    villager: { name: 'Villager', team: 'town', description: 'You have no special powers. Use the day discussion and vote to find and eliminate the Mafia.' },
    doctor: { name: 'Doctor', team: 'town', description: 'Each night, choose one player (including yourself) to protect from the Mafia\'s kill.' },
    detective: { name: 'Detective', team: 'town', description: 'Each night, investigate one player to learn whether they are Mafia or not.' }
};

let state = {
    phase: 'lobby', // lobby | night | discussion | voting | tiebreak | gameover
    round: 0,
    phaseStartedAt: null,
    settings: { discussionSeconds: 90, minPlayers: 5, maxPlayers: 15 },
    hostToken: null,
    gameOverInfo: null
};

let players = new Map(); // token -> player
let night = null;        // { mafiaVotes: Map(token -> targetPid|null), doctorAction, detectiveAction, submitted: Set(token) }
let voting = null;       // { votes: Map(token -> targetPid|null) }
let tie = null;          // { candidates: [pid, ...] }
let lastNightDeaths = [];
let lastVoteResult = null;

function genId(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function findByClientId(clientId) {
    for (const p of players.values()) if (p.clientId === clientId) return p;
    return null;
}

function findByPid(pid) {
    for (const p of players.values()) if (p.pid === pid) return p;
    return null;
}

function countReal() {
    let n = 0;
    for (const p of players.values()) if (!p.isSpectator) n++;
    return n;
}

function recomputeHost() {
    const current = state.hostToken ? players.get(state.hostToken) : null;
    if (current && current.connected && !current.isSpectator) return;
    for (const p of players.values()) {
        if (p.connected && !p.isSpectator) {
            state.hostToken = p.token;
            return;
        }
    }
}

function sendError(p, message) {
    if (p && p.clientId) socket.emitTo(p.clientId, 'error', { message });
}

function publicPlayer(p) {
    return {
        pid: p.pid,
        name: p.name,
        ready: p.ready,
        alive: p.alive,
        connected: p.connected,
        isHost: p.token === state.hostToken,
        isSpectator: p.isSpectator
    };
}

function publicState() {
    return {
        phase: state.phase,
        round: state.round,
        phaseStartedAt: state.phaseStartedAt,
        settings: state.settings,
        players: [...players.values()].map(publicPlayer),
        night: state.phase === 'night' && night
            ? { submittedPids: [...night.submitted].map((t) => players.get(t).pid) }
            : null,
        voting: state.phase === 'voting' && voting
            ? { votedPids: [...voting.votes.keys()].map((t) => players.get(t).pid) }
            : null,
        tie: state.phase === 'tiebreak' && tie
            ? { candidates: tie.candidates.map((pid) => ({ pid, name: findByPid(pid)?.name || 'Unknown' })) }
            : null,
        lastNightDeaths: lastNightDeaths.map((pid) => ({ pid, name: findByPid(pid)?.name || 'Unknown' })),
        lastVoteResult,
        gameOver: state.gameOverInfo
    };
}

function broadcastPublic() {
    socket.broadcast({ event: 'state', data: publicState() });
}

function sendYouState(p) {
    if (!p.connected || !p.clientId) return;
    const roleInfo = p.role ? ROLE_INFO[p.role] : null;
    const teammates = p.role === ROLES.MAFIA
        ? [...players.values()]
            .filter((o) => o.role === ROLES.MAFIA && o.token !== p.token && !o.isSpectator)
            .map((o) => ({ pid: o.pid, name: o.name }))
        : [];
    socket.emitTo(p.clientId, 'you_state', {
        pid: p.pid,
        token: p.token,
        name: p.name,
        isHost: p.token === state.hostToken,
        role: p.role,
        roleName: roleInfo ? roleInfo.name : null,
        roleTeam: roleInfo ? roleInfo.team : null,
        roleDescription: roleInfo ? roleInfo.description : null,
        teammates,
        alive: p.alive,
        isSpectator: p.isSpectator,
        investigations: p.investigations
    });
}

function broadcastYouStateAll() {
    for (const p of players.values()) sendYouState(p);
}

function checkWinCondition() {
    const alive = [...players.values()].filter((p) => p.alive && !p.isSpectator);
    const aliveMafia = alive.filter((p) => p.role === ROLES.MAFIA).length;
    const aliveTown = alive.length - aliveMafia;
    if (aliveMafia === 0) return 'town';
    if (aliveMafia >= aliveTown) return 'mafia';
    return null;
}

function assignRoles() {
    const tokens = shuffle([...players.values()].filter((p) => !p.isSpectator).map((p) => p.token));
    const n = tokens.length;
    const mafiaCount = Math.max(1, Math.floor(n / 4));
    const hasDoctor = n >= state.settings.minPlayers;
    const hasDetective = n >= state.settings.minPlayers;

    let idx = 0;
    const mafiaTokens = tokens.slice(idx, idx + mafiaCount); idx += mafiaCount;
    const doctorToken = hasDoctor ? tokens[idx++] : null;
    const detectiveToken = hasDetective ? tokens[idx++] : null;

    for (const t of tokens) {
        const p = players.get(t);
        p.alive = true;
        p.investigations = [];
        if (mafiaTokens.includes(t)) p.role = ROLES.MAFIA;
        else if (t === doctorToken) p.role = ROLES.DOCTOR;
        else if (t === detectiveToken) p.role = ROLES.DETECTIVE;
        else p.role = ROLES.VILLAGER;
    }
}

function startNight() {
    night = { mafiaVotes: new Map(), doctorAction: undefined, detectiveAction: undefined, submitted: new Set() };
    state.phase = 'night';
    state.phaseStartedAt = Date.now();
    broadcastYouStateAll();
    broadcastPublic();
}

function nightRequiredTokens() {
    const required = new Set();
    for (const p of players.values()) {
        if (!p.alive || p.isSpectator) continue;
        if (p.role === ROLES.MAFIA || p.role === ROLES.DOCTOR || p.role === ROLES.DETECTIVE) required.add(p.token);
    }
    return required;
}

function maybeResolveNight(force) {
    if (!night) return;
    const required = nightRequiredTokens();
    const allSubmitted = [...required].every((t) => night.submitted.has(t));
    if (!allSubmitted && !force) return;
    resolveNight();
}

function resolveNight() {
    const tally = new Map();
    for (const targetPid of night.mafiaVotes.values()) {
        if (!targetPid) continue;
        tally.set(targetPid, (tally.get(targetPid) || 0) + 1);
    }
    let killTargetPid = null;
    if (tally.size > 0) {
        const max = Math.max(...tally.values());
        const topPids = [...tally.entries()].filter(([, c]) => c === max).map(([pid]) => pid);
        killTargetPid = topPids[Math.floor(Math.random() * topPids.length)];
    }

    const doctorSaveTarget = night.doctorAction === undefined ? null : night.doctorAction;
    const detectiveTarget = night.detectiveAction === undefined ? null : night.detectiveAction;

    lastNightDeaths = [];
    if (killTargetPid && killTargetPid !== doctorSaveTarget) {
        const victim = findByPid(killTargetPid);
        if (victim && victim.alive) {
            victim.alive = false;
            lastNightDeaths.push(victim.pid);
        }
    }

    if (detectiveTarget) {
        const target = findByPid(detectiveTarget);
        const detective = [...players.values()].find((p) => p.role === ROLES.DETECTIVE);
        if (detective && target) {
            detective.investigations.push({
                round: state.round,
                targetPid: target.pid,
                targetName: target.name,
                result: target.role === ROLES.MAFIA ? 'mafia' : 'not-mafia'
            });
        }
    }

    night = null;
    const winner = checkWinCondition();
    if (winner) { endGame(winner); return; }

    state.phase = 'discussion';
    state.phaseStartedAt = Date.now();
    broadcastYouStateAll();
    broadcastPublic();
}

function votingRequiredTokens() {
    const required = new Set();
    for (const p of players.values()) if (p.alive && !p.isSpectator) required.add(p.token);
    return required;
}

function maybeResolveVoting(force) {
    if (!voting) return;
    const required = votingRequiredTokens();
    const allVoted = [...required].every((t) => voting.votes.has(t));
    if (!allVoted && !force) return;
    resolveVoting();
}

function resolveVoting() {
    const tally = new Map();
    for (const targetPid of voting.votes.values()) {
        if (!targetPid) continue;
        tally.set(targetPid, (tally.get(targetPid) || 0) + 1);
    }
    voting = null;

    if (tally.size === 0) {
        lastVoteResult = { eliminatedName: null, wasTie: false };
        advanceAfterElimination();
        return;
    }

    const max = Math.max(...tally.values());
    const topPids = [...tally.entries()].filter(([, c]) => c === max).map(([pid]) => pid);

    if (topPids.length > 1) {
        tie = { candidates: topPids };
        state.phase = 'tiebreak';
        broadcastPublic();
        return;
    }

    eliminateByVote(topPids[0], false);
}

function eliminateByVote(pid, wasTie) {
    const target = findByPid(pid);
    if (target && target.alive) target.alive = false;
    lastVoteResult = { eliminatedName: target ? target.name : null, wasTie };
    advanceAfterElimination();
}

function advanceAfterElimination() {
    const winner = checkWinCondition();
    if (winner) { endGame(winner); return; }
    state.round += 1;
    startNight();
}

function endGame(winner) {
    state.phase = 'gameover';
    state.gameOverInfo = {
        winner,
        reveal: [...players.values()]
            .filter((p) => !p.isSpectator)
            .map((p) => ({ pid: p.pid, name: p.name, role: p.role, roleName: ROLE_INFO[p.role]?.name || p.role, alive: p.alive }))
    };
    broadcastYouStateAll();
    broadcastPublic();
}

function resetToLobby() {
    for (const p of players.values()) {
        p.isSpectator = false;
        p.ready = false;
        p.alive = true;
        p.role = null;
        p.investigations = [];
    }
    state.phase = 'lobby';
    state.round = 0;
    state.phaseStartedAt = null;
    state.gameOverInfo = null;
    lastNightDeaths = [];
    lastVoteResult = null;
    night = null;
    voting = null;
    tie = null;
    broadcastYouStateAll();
    broadcastPublic();
}

socket.on('connect', () => {});

socket.on('disconnect', (client) => {
    const p = findByClientId(client.id);
    if (!p) return;
    p.connected = false;
    p.clientId = null;
    recomputeHost();
    broadcastPublic();
});

socket.on('join', (client, data) => {
    const name = (data && typeof data.name === 'string' && data.name.trim())
        ? data.name.trim().slice(0, 20)
        : 'Player';
    let token = data && typeof data.token === 'string' && data.token ? data.token : null;
    let p = token ? players.get(token) : null;

    if (p) {
        p.clientId = client.id;
        p.connected = true;
        if (state.phase === 'lobby') p.name = name;
    } else {
        token = token || genId('tok');
        const isSpectator = state.phase !== 'lobby' || countReal() >= state.settings.maxPlayers;
        p = {
            token,
            pid: genId('p'),
            clientId: client.id,
            name,
            ready: false,
            alive: !isSpectator,
            connected: true,
            role: null,
            isSpectator,
            investigations: []
        };
        players.set(token, p);
    }

    recomputeHost();
    socket.emitTo(client.id, 'joined', { token: p.token, pid: p.pid });
    sendYouState(p);
    broadcastPublic();
});

socket.on('toggleReady', (client) => {
    const p = findByClientId(client.id);
    if (!p || p.isSpectator || state.phase !== 'lobby') return;
    p.ready = !p.ready;
    broadcastPublic();
});

socket.on('updateSettings', (client, data) => {
    const p = findByClientId(client.id);
    if (!p || p.token !== state.hostToken || state.phase !== 'lobby') return;
    const seconds = Number(data && data.discussionSeconds);
    if (Number.isFinite(seconds)) {
        state.settings.discussionSeconds = Math.min(300, Math.max(30, Math.round(seconds)));
    }
    broadcastPublic();
});

socket.on('startGame', (client) => {
    const p = findByClientId(client.id);
    if (!p || p.token !== state.hostToken) { sendError(p, 'Only the host can start the game'); return; }
    if (state.phase !== 'lobby') return;
    const real = [...players.values()].filter((pl) => !pl.isSpectator);
    if (real.length < state.settings.minPlayers) {
        sendError(p, `Need at least ${state.settings.minPlayers} players to start`);
        return;
    }
    if (!real.every((pl) => pl.ready)) {
        sendError(p, 'All players must be ready');
        return;
    }
    assignRoles();
    state.round = 1;
    startNight();
});

socket.on('nightAction', (client, data) => {
    const p = findByClientId(client.id);
    if (!p || state.phase !== 'night' || !night || !p.alive || p.isSpectator) return;
    const targetPid = data && data.targetPid ? data.targetPid : null;

    if (p.role === ROLES.MAFIA) {
        if (targetPid) {
            const target = findByPid(targetPid);
            if (!target || !target.alive || target.role === ROLES.MAFIA) return;
        }
        night.mafiaVotes.set(p.token, targetPid);
    } else if (p.role === ROLES.DOCTOR) {
        if (targetPid) {
            const target = findByPid(targetPid);
            if (!target || !target.alive) return;
        }
        night.doctorAction = targetPid;
    } else if (p.role === ROLES.DETECTIVE) {
        if (targetPid) {
            const target = findByPid(targetPid);
            if (!target || !target.alive || target.pid === p.pid) return;
        }
        night.detectiveAction = targetPid;
    } else {
        return;
    }

    night.submitted.add(p.token);
    maybeResolveNight(false);
    broadcastPublic();
});

socket.on('forceEndNight', (client) => {
    const p = findByClientId(client.id);
    if (!p || p.token !== state.hostToken || state.phase !== 'night') return;
    maybeResolveNight(true);
});

socket.on('startVoting', (client) => {
    const p = findByClientId(client.id);
    if (!p || p.token !== state.hostToken || state.phase !== 'discussion') return;
    voting = { votes: new Map() };
    state.phase = 'voting';
    state.phaseStartedAt = Date.now();
    broadcastPublic();
});

socket.on('castVote', (client, data) => {
    const p = findByClientId(client.id);
    if (!p || state.phase !== 'voting' || !voting || !p.alive || p.isSpectator) return;
    const targetPid = data && data.targetPid ? data.targetPid : null;
    if (targetPid) {
        if (targetPid === p.pid) return;
        const target = findByPid(targetPid);
        if (!target || !target.alive) return;
    }
    voting.votes.set(p.token, targetPid);
    maybeResolveVoting(false);
    broadcastPublic();
});

socket.on('forceEndVoting', (client) => {
    const p = findByClientId(client.id);
    if (!p || p.token !== state.hostToken || state.phase !== 'voting') return;
    maybeResolveVoting(true);
});

socket.on('resolveTie', (client, data) => {
    const p = findByClientId(client.id);
    if (!p || p.token !== state.hostToken || state.phase !== 'tiebreak' || !tie) return;
    const pid = data && data.targetPid ? data.targetPid : null;
    if (pid && !tie.candidates.includes(pid)) return;
    tie = null;
    if (pid) eliminateByVote(pid, true);
    else {
        lastVoteResult = { eliminatedName: null, wasTie: true };
        advanceAfterElimination();
    }
});

socket.on('playAgain', (client) => {
    const p = findByClientId(client.id);
    if (!p || p.token !== state.hostToken || state.phase !== 'gameover') return;
    resetToLobby();
});
