const express = require("express")
const WebSocket = require("ws")
const { WebcastPushConnection } = require("tiktok-live-connector")

const app = express()
app.use(express.static("public"))
app.use(express.json())

const server = app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
    console.log(`Server running on port ${process.env.PORT || 3000}`)
})

const wss = new WebSocket.Server({ server })

function broadcast(msg) {
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify(msg))
        }
    })
}

let currentTikTokUsername = ""
let tiktokConnection = null
let connectInFlight = false
let activeConnectionId = 0
let manualDisconnect = false

function broadcastTikTokReset() {
    broadcast({
        platform: "tiktok",
        type: "reset"
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
}

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

    if (connectInFlight) {
        throw new Error("A TikTok connection update is already in progress")
    }

    connectInFlight = true

    try {
        if (cleanUsername === currentTikTokUsername && tiktokConnection) {
            return {
                ok: true,
                status: "connected",
                username: cleanUsername
            }
        }

        activeConnectionId += 1
        const connectionId = activeConnectionId

        await disconnectTikTok()
        broadcastTikTokReset()

        currentTikTokUsername = cleanUsername

        if (!cleanUsername) {
            broadcast({
                platform: "tiktok",
                type: "status",
                status: "idle",
                username: ""
            })

            return {
                ok: true,
                status: "idle",
                username: ""
            }
        }

        broadcast({
            platform: "tiktok",
            type: "status",
            status: "connecting",
            username: cleanUsername
        })

        console.log("Connecting to TikTok:", cleanUsername)

        const tiktok = new WebcastPushConnection(cleanUsername)
        tiktokConnection = tiktok

        attachTikTokHandlers(tiktok, cleanUsername, connectionId)

        // timeout הגיוני כדי לא להיתקע לנצח
        await Promise.race([
            tiktok.connect(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("TikTok connection timed out")), 15000)
            )
        ])

        if (connectionId !== activeConnectionId) {
            throw new Error("Connection was replaced by a newer request")
        }

        console.log("Connected to TikTok:", cleanUsername)

        broadcast({
            platform: "tiktok",
            type: "status",
            status: "connected",
            username: cleanUsername
        })

        return {
            ok: true,
            status: "connected",
            username: cleanUsername
        }
    } catch (err) {
        await disconnectTikTok()

        broadcast({
            platform: "tiktok",
            type: "status",
            status: "offline",
            username: cleanUsername,
            error: err.message
        })

        throw err
    } finally {
        connectInFlight = false
    }
}

app.get("/config", (req, res) => {
    res.json({
        tiktokUsername: currentTikTokUsername
    })
})

app.post("/config", async (req, res) => {
    try {
        const tiktokUsername = String(req.body?.tiktokUsername || "").trim().replace(/^@/, "")
        const result = await connectTikTok(tiktokUsername)

        res.json({
            ok: true,
            tiktokUsername: result.username,
            status: result.status
        })
    } catch (err) {
        res.status(500).json({
            ok: false,
            error: err.message || "TikTok connection failed"
        })
    }
})