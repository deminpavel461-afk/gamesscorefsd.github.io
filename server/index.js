const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const PAYOUT_COUNTS = [7, 6, 5, 4];

const DEFAULT_DB = {
	players: [
		"Вова Гаврилюк",
		"Сан Саныч",
		"Андрей Русских",
		"Стас Бушуев",
		"DedPool",
		"Паша Шерр",
		"ZAZUZAZI",
	],
	admin: {
		login: "Володя Гаврилюк",
		password: "admin",
	},
	payouts: {
		7: { first: 600, second: 150, other: -150 },
		6: { first: 500, second: 100, other: -150 },
		5: { first: 450, second: 0, other: -150 },
		4: { first: 450, second: -150, other: -150 },
	},
	games: [],
	nextGameId: 1,
	sessions: {},
};

const MIME = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".fig": "application/octet-stream",
	".txt": "text/plain; charset=utf-8",
};

function ensureDb() {
	if (!fs.existsSync(DATA_DIR)) {
		fs.mkdirSync(DATA_DIR, { recursive: true });
	}
	if (!fs.existsSync(DB_PATH)) {
		fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2), "utf8");
	}
}

function readDb() {
	ensureDb();
	const raw = fs.readFileSync(DB_PATH, "utf8");
	const db = JSON.parse(raw);
	if (!db.sessions) {
		db.sessions = {};
	}
	if (!Array.isArray(db.games)) {
		db.games = [];
	}
	if (!db.nextGameId) {
		db.nextGameId = 1;
	}
	return db;
}

function writeDb(db) {
	ensureDb();
	fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
	});
	res.end(body);
}

function readBody(req) {
	return new Promise(function (resolve, reject) {
		const chunks = [];
		req.on("data", function (chunk) {
			chunks.push(chunk);
			if (Buffer.concat(chunks).length > 1e6) {
				reject(new Error("Payload too large"));
				req.destroy();
			}
		});
		req.on("end", function () {
			if (!chunks.length) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(new Error("Invalid JSON"));
			}
		});
		req.on("error", reject);
	});
}

function normalizeLogin(value) {
	return String(value || "")
		.trim()
		.replace(/\s+/g, " ");
}

function getToken(req) {
	const header = req.headers.authorization || "";
	if (header.toLowerCase().startsWith("bearer ")) {
		return header.slice(7).trim();
	}
	return "";
}

function getSession(db, token) {
	if (!token || !db.sessions[token]) {
		return null;
	}
	const session = db.sessions[token];
	if (session.expiresAt && Date.now() > session.expiresAt) {
		delete db.sessions[token];
		writeDb(db);
		return null;
	}
	return session;
}

function requireAdmin(req, res, db) {
	const session = getSession(db, getToken(req));
	if (!session || session.login !== db.admin.login) {
		sendJson(res, 401, { error: "Требуется вход администратора" });
		return null;
	}
	return session;
}

function publicState(db) {
	return {
		players: db.players,
		payouts: db.payouts,
		games: db.games,
	};
}

function clonePayouts(source) {
	const result = {};
	PAYOUT_COUNTS.forEach(function (count) {
		const key = String(count);
		const row = source[key] || source[count] || DEFAULT_DB.payouts[key];
		result[key] = {
			first: Number(row.first),
			second: Number(row.second),
			other: Number(row.other),
		};
	});
	return result;
}

function validateGame(body, players) {
	if (!body || typeof body !== "object") {
		return "Некорректные данные";
	}

	const date = String(body.date || "");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		return "Укажите корректную дату";
	}

	if (!Array.isArray(body.players) || body.players.length < 4 || body.players.length > 7) {
		return "В игре должно быть от 4 до 7 игроков";
	}

	const unique = [];
	for (let i = 0; i < body.players.length; i += 1) {
		const name = String(body.players[i]);
		if (players.indexOf(name) === -1) {
			return "Неизвестный игрок: " + name;
		}
		if (unique.indexOf(name) !== -1) {
			return "Игроки не должны повторяться";
		}
		unique.push(name);
	}

	const first = String(body.first || "");
	const second = String(body.second || "");
	if (!first || !second) {
		return "Укажите 1 и 2 место";
	}
	if (first === second) {
		return "1 и 2 место должны быть разными";
	}
	if (unique.indexOf(first) === -1 || unique.indexOf(second) === -1) {
		return "Призёры должны быть среди выбранных игроков";
	}

	return null;
}

function serveStatic(req, res, pathname) {
	let relative = decodeURIComponent(pathname);
	if (relative === "/") {
		relative = "/index.html";
	}

	const filePath = path.normalize(path.join(ROOT, relative));
	if (!filePath.startsWith(ROOT) || filePath.startsWith(path.join(ROOT, "server", "data"))) {
		sendJson(res, 403, { error: "Forbidden" });
		return;
	}

	fs.readFile(filePath, function (error, data) {
		if (error) {
			sendJson(res, 404, { error: "Not found" });
			return;
		}
		const ext = path.extname(filePath).toLowerCase();
		res.writeHead(200, {
			"Content-Type": MIME[ext] || "application/octet-stream",
			"Content-Length": data.length,
		});
		res.end(data);
	});
}

async function handleApi(req, res, pathname) {
	const db = readDb();
	const method = req.method.toUpperCase();

	if (method === "GET" && pathname === "/api/health") {
		sendJson(res, 200, { ok: true });
		return;
	}

	if (method === "GET" && pathname === "/api/state") {
		const session = getSession(db, getToken(req));
		sendJson(res, 200, {
			...publicState(db),
			user: session ? { login: session.login, isAdmin: true } : null,
		});
		return;
	}

	if (method === "POST" && pathname === "/api/auth/login") {
		const body = await readBody(req);
		const login = normalizeLogin(body.login);
		const password = String(body.password || "");
		const remember = Boolean(body.remember);

		if (!login || !password) {
			sendJson(res, 400, { error: "Введите логин и пароль" });
			return;
		}

		if (login !== db.admin.login || password !== db.admin.password) {
			sendJson(res, 401, { error: "Неверный логин или пароль" });
			return;
		}

		const token = crypto.randomBytes(24).toString("hex");
		const ttl = remember ? 1000 * 60 * 60 * 24 * 30 : 1000 * 60 * 60 * 12;
		db.sessions[token] = {
			login: db.admin.login,
			expiresAt: Date.now() + ttl,
			remember: remember,
		};
		writeDb(db);

		sendJson(res, 200, {
			token: token,
			user: { login: db.admin.login, isAdmin: true },
			remember: remember,
		});
		return;
	}

	if (method === "POST" && pathname === "/api/auth/logout") {
		const token = getToken(req);
		if (token && db.sessions[token]) {
			delete db.sessions[token];
			writeDb(db);
		}
		sendJson(res, 200, { ok: true });
		return;
	}

	if (method === "GET" && pathname === "/api/auth/me") {
		const session = getSession(db, getToken(req));
		if (!session) {
			sendJson(res, 401, { error: "Не авторизован" });
			return;
		}
		sendJson(res, 200, { user: { login: session.login, isAdmin: true } });
		return;
	}

	if (method === "POST" && pathname === "/api/games") {
		if (!requireAdmin(req, res, db)) {
			return;
		}
		const body = await readBody(req);
		const error = validateGame(body, db.players);
		if (error) {
			sendJson(res, 400, { error: error });
			return;
		}

		const game = {
			id: db.nextGameId,
			date: body.date,
			players: body.players.slice(),
			first: body.first,
			second: body.second,
		};
		db.nextGameId += 1;
		db.games.push(game);
		writeDb(db);
		sendJson(res, 201, { game: game, games: db.games });
		return;
	}

	const gameMatch = pathname.match(/^\/api\/games\/(\d+)$/);
	if (method === "PUT" && gameMatch) {
		if (!requireAdmin(req, res, db)) {
			return;
		}
		const id = Number(gameMatch[1]);
		const index = db.games.findIndex(function (game) {
			return Number(game.id) === id;
		});
		if (index === -1) {
			sendJson(res, 404, { error: "Игра не найдена" });
			return;
		}

		const body = await readBody(req);
		const error = validateGame(body, db.players);
		if (error) {
			sendJson(res, 400, { error: error });
			return;
		}

		db.games[index] = {
			id: db.games[index].id,
			date: body.date,
			players: body.players.slice(),
			first: body.first,
			second: body.second,
		};
		writeDb(db);
		sendJson(res, 200, { game: db.games[index], games: db.games });
		return;
	}

	if (method === "DELETE" && pathname === "/api/games") {
		if (!requireAdmin(req, res, db)) {
			return;
		}
		db.games = [];
		db.nextGameId = 1;
		writeDb(db);
		sendJson(res, 200, { games: [] });
		return;
	}

	if (method === "PUT" && pathname === "/api/payouts") {
		if (!requireAdmin(req, res, db)) {
			return;
		}
		const body = await readBody(req);
		const next = clonePayouts(body && body.payouts ? body.payouts : body || {});

		for (let i = 0; i < PAYOUT_COUNTS.length; i += 1) {
			const key = String(PAYOUT_COUNTS[i]);
			const row = next[key];
			if (
				!row ||
				!Number.isFinite(row.first) ||
				!Number.isFinite(row.second) ||
				!Number.isFinite(row.other)
			) {
				sendJson(res, 400, { error: "Введите корректные суммы для всех строк" });
				return;
			}
		}

		db.payouts = next;
		writeDb(db);
		sendJson(res, 200, { payouts: db.payouts });
		return;
	}

	sendJson(res, 404, { error: "API route not found" });
}

const server = http.createServer(async function (req, res) {
	try {
		const host = req.headers.host || "localhost";
		const url = new URL(req.url, "http://" + host);
		const pathname = url.pathname;

		if (pathname.startsWith("/api/")) {
			await handleApi(req, res, pathname);
			return;
		}

		if (req.method === "GET" || req.method === "HEAD") {
			serveStatic(req, res, pathname);
			return;
		}

		sendJson(res, 405, { error: "Method not allowed" });
	} catch (error) {
		sendJson(res, 500, { error: error.message || "Server error" });
	}
});

ensureDb();
server.listen(PORT, function () {
	console.log("GamesScoreFSD backend: http://localhost:" + PORT);
});
