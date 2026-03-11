const express = require("express")
const WebSocket = require("ws")
const { WebcastPushConnection } = require("tiktok-live-connector")

const app = express()
app.use(express.static("public"))
app.use(express.json())

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

const wss = new WebSocket.Server({ server })

function broadcast(msg) {
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify(msg))
        }
    })
}

////////////////////////////
// CONFIG
////////////////////////////

let currentTikTokUsername = ""

////////////////////////////
// TIKTOK STATE
////////////////////////////

let tiktokConnection = null
let manualDisconnect = false
let activeConnectionId = 0

function attachTikTokHandlers(tiktok, username, connectionId) {
    tiktok.on("chat", data => {
        if (connectionId !== activeConnectionId) return

        broadcast({
            platform: "tiktok",
            type: "chat",
            user: data.nickname,
            text: data.comment
        })
    })

    tiktok.on("roomUser", data => {
        if (connectionId !== activeConnectionId) return

        broadcast({
            platform: "tiktok",
            type: "viewers",
            viewers: data.viewerCount
        })
    })

    tiktok.on("like", data => {
        if (connectionId !== activeConnectionId) return

        broadcast({
            platform: "tiktok",
            type: "likes",
            likes: data.totalLikeCount
        })
    })

    tiktok.on("gift", data => {
        if (connectionId !== activeConnectionId) return

        broadcast({
            platform: "tiktok",
            type: "gift",
            user: data.nickname,
            gift: data.giftName,
            amount: data.repeatCount
        })
    })

    tiktok.on("streamEnd", () => {
        if (connectionId !== activeConnectionId) return

        console.log("TikTok stream ended for", username)

        broadcast({
            platform: "tiktok",
            type: "status",
            status: "offline",
            username
        })
    })

    tiktok.on("disconnected", () => {
        if (connectionId !== activeConnectionId) return

        if (manualDisconnect) return

        console.log("TikTok disconnected for", username)

        broadcast({
            platform: "tiktok",
            type: "status",
            status: "offline",
            username
        })
    })
}

async function disconnectTikTok() {
    if (!tiktokConnection) return

    try {
        manualDisconnect = true

        if (typeof tiktokConnection.disconnect === "function") {
            await tiktokConnection.disconnect()
        }
    } catch (err) {
        console.log("TikTok disconnect error:", err.message)
    } finally {
        tiktokConnection = null
        manualDisconnect = false
    }
}

async function connectTikTok(username) {
    const cleanUsername = String(username || "").trim().replace(/^@/, "")

    currentTikTokUsername = cleanUsername
    activeConnectionId += 1
    const connectionId = activeConnectionId

    await disconnectTikTok()

    if (!cleanUsername) {
        broadcast({
            platform: "tiktok",
            type: "status",
            status: "idle",
            username: ""
        })

        broadcast({
            platform: "tiktok",
            type: "viewers",
            viewers: 0
        })

        broadcast({
            platform: "tiktok",
            type: "likes",
            likes: 0
        })

        return
    }

    try {
        console.log("Connecting to TikTok:", cleanUsername)

        const tiktok = new WebcastPushConnection(cleanUsername)
        tiktokConnection = tiktok

        attachTikTokHandlers(tiktok, cleanUsername, connectionId)
        await tiktok.connect()

        if (connectionId !== activeConnectionId) {
            return
        }

        console.log("Connected to TikTok:", cleanUsername)

        broadcast({
            platform: "tiktok",
            type: "status",
            status: "connected",
            username: cleanUsername
        })
    } catch (err) {
        if (connectionId !== activeConnectionId) {
            return
        }

        console.log("TikTok connection failed:", err.message)

        broadcast({
            platform: "tiktok",
            type: "status",
            status: "offline",
            username: cleanUsername,
            error: err.message
        })
    }
}

////////////////////////////
// API
////////////////////////////

app.get("/config", (req, res) => {
    res.json({
        tiktokUsername: currentTikTokUsername
    })
})

app.post("/config", async (req, res) => {
    const tiktokUsername = String(req.body?.tiktokUsername || "").trim().replace(/^@/, "")

    currentTikTokUsername = tiktokUsername
    await connectTikTok(tiktokUsername)

    res.json({
        ok: true,
        tiktokUsername: currentTikTokUsername
    })
})

////////////////////////////
// START
////////////////////////////

// no automatic TikTok connection on startup