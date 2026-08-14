package de.galaxushd.mpsqcamera;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Vec3d;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/** HTTP access to the public MPSQ Edge Function. No Supabase secret is stored in the mod. */
public final class MpsqApiClient {
    public static final String API_URL = "https://hbikjzzkxsvjoqnedbmm.supabase.co/functions/v1/mpsq-api";
    private static final Path TOKEN_FILE = FabricLoader.getInstance().getConfigDir().resolve("mpsqcamera-token.txt");
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private static final Gson GSON = new Gson();
    private static String token;

    private MpsqApiClient() { }

    public static CompletableFuture<Void> initialize() {
        token = readToken();
        String displayName = currentDisplayName();
        if (token != null && !token.isBlank()) {
            JsonObject body = new JsonObject();
            body.addProperty("displayName", displayName);
            return request("PATCH", "/me", body, true).thenApply(ignored -> (Void) null)
                    .exceptionally(ignored -> null);
        }
        JsonObject body = new JsonObject();
        body.addProperty("displayName", displayName);
        return request("POST", "/register", body, false).thenAccept(json -> {
            token = json.getAsJsonObject().get("token").getAsString();
            try {
                Files.createDirectories(TOKEN_FILE.getParent());
                Files.writeString(TOKEN_FILE, token, StandardCharsets.UTF_8);
            } catch (IOException exception) {
                throw new IllegalStateException("MPSQ-Zugang konnte nicht gespeichert werden", exception);
            }
        });
    }

    public static CompletableFuture<JsonElement> get(String path) { return request("GET", path, null, true); }
    public static CompletableFuture<JsonElement> post(String path, JsonObject body) { return request("POST", path, body, true); }
    public static CompletableFuture<JsonElement> patch(String path, JsonObject body) { return request("PATCH", path, body, true); }
    public static CompletableFuture<JsonElement> delete(String path) { return request("DELETE", path, null, true); }

    /** Uploads one low-rate PNG frame for a camera currently viewed by this client. */
    public static CompletableFuture<JsonElement> postCameraFrame(UUID cameraId, byte[] png) {
        JsonObject body = new JsonObject();
        body.addProperty("pngBase64", Base64.getEncoder().encodeToString(png));
        return post("/cameras/" + cameraId + "/frame", body);
    }

    /** Cameras whose wearer is this client. Their wearer publishes a bodycam frame. */
    public static CompletableFuture<List<UUID>> loadMyBodycamIds() {
        return get("/bodycams/mine").thenApply(json -> {
            List<UUID> ids = new ArrayList<>();
            if (!json.isJsonArray()) return ids;
            for (JsonElement row : json.getAsJsonArray()) {
                if (row.isJsonObject() && row.getAsJsonObject().has("id")) {
                    ids.add(UUID.fromString(row.getAsJsonObject().get("id").getAsString()));
                }
            }
            return ids;
        });
    }

    /** True once this client has a local API token and can safely poll shared screen state. */
    public static boolean isReady() {
        return token != null && !token.isBlank();
    }

    public static CompletableFuture<List<LocalCameraStore.CameraData>> loadCameras() {
        // Includes own cameras and cameras attached to screens this client may
        // view. A nearby mod user can therefore become a static-camera source.
        return get("/cameras/accessible").thenApply(json -> {
            List<LocalCameraStore.CameraData> cameras = new ArrayList<>();
            for (JsonElement element : json.getAsJsonArray()) {
                JsonObject row = element.getAsJsonObject();
                LocalCameraStore.CameraKind kind = "BODYCAM".equals(row.get("kind").getAsString())
                        ? LocalCameraStore.CameraKind.BODYCAM : LocalCameraStore.CameraKind.STATIC;
                Vec3d position = row.get("x").isJsonNull() ? null : new Vec3d(row.get("x").getAsDouble(), row.get("y").getAsDouble(), row.get("z").getAsDouble());
                UUID wearer = row.has("body_owner_id") && !row.get("body_owner_id").isJsonNull()
                        ? UUID.fromString(row.get("body_owner_id").getAsString()) : null;
                String wearerName = row.has("body_owner_name") && !row.get("body_owner_name").isJsonNull()
                        ? row.get("body_owner_name").getAsString() : null;
                cameras.add(new LocalCameraStore.CameraData(UUID.fromString(row.get("id").getAsString()), row.get("name").getAsString(), kind,
                        row.get("dimension").getAsString(), position, row.get("yaw").getAsFloat(), row.get("pitch").getAsFloat(), wearer, wearerName));
            }
            return cameras;
        });
    }

    /** Refreshes the local camera cache and its client-only holograms from the shared API. */
    public static CompletableFuture<Void> refreshCameras() {
        return loadCameras().thenAccept(cameras -> MinecraftClient.getInstance().execute(() -> {
            LocalCameraStore.getAll().forEach(camera -> CameraHologramManager.remove(camera.id()));
            LocalCameraStore.replaceAll(cameras);
            cameras.forEach(CameraHologramManager::show);
        }));
    }

    public static CompletableFuture<List<LocalScreenStore.LocalScreenData>> loadScreens() {
        return get("/screens").thenApply(json -> {
            List<LocalScreenStore.LocalScreenData> screens = new ArrayList<>();
            for (JsonElement element : json.getAsJsonArray()) {
                JsonObject row = element.getAsJsonObject();
                BlockPos pos1 = new BlockPos(row.get("pos1_x").getAsInt(), row.get("pos1_y").getAsInt(), row.get("pos1_z").getAsInt());
                BlockPos pos2 = new BlockPos(row.get("pos2_x").getAsInt(), row.get("pos2_y").getAsInt(), row.get("pos2_z").getAsInt());
                LocalScreenStore.ScreenInputType mode = "CAMERA".equals(row.get("mode").getAsString())
                        ? LocalScreenStore.ScreenInputType.CAMERA : LocalScreenStore.ScreenInputType.LINK;
                UUID cameraId = null;
                if (row.has("mpsq_screen_cameras") && row.get("mpsq_screen_cameras").isJsonArray()) {
                    JsonArray cameras = row.getAsJsonArray("mpsq_screen_cameras");
                    List<UUID> cameraIds = new ArrayList<>();
                    for (JsonElement camera : cameras) cameraIds.add(UUID.fromString(camera.getAsJsonObject().get("camera_id").getAsString()));
                    ScreenCameraStore.put(UUID.fromString(row.get("id").getAsString()), cameraIds);
                    if (!cameraIds.isEmpty()) cameraId = cameraIds.get(0);
                }
                UUID groupId = row.has("group_id") && !row.get("group_id").isJsonNull() ? UUID.fromString(row.get("group_id").getAsString()) : null;
                screens.add(new LocalScreenStore.LocalScreenData(UUID.fromString(row.get("id").getAsString()), pos1, pos2,
                        row.get("name").getAsString(), new Vec3d(pos1.getX(), pos1.getY(), pos1.getZ()), mode,
                        row.has("cinema_url") && !row.get("cinema_url").isJsonNull() ? row.get("cinema_url").getAsString() : "", cameraId, groupId));
            }
            return screens;
        });
    }

    /** Loads the signed-in user's shared MPSQ Team role. */
    public static CompletableFuture<TeamProfile> refreshTeamProfile() {
        return get("/team/me").thenApply(MpsqApiClient::parseTeamProfile).thenApply(profile -> {
            TeamStateStore.setSelf(profile);
            return profile;
        });
    }

    /** The API only returns members the signed-in user is allowed to see. */
    public static CompletableFuture<List<TeamProfile>> refreshTeamMembers() {
        return get("/team/members").thenApply(json -> {
            List<TeamProfile> members = new ArrayList<>();
            if (!json.isJsonArray()) return members;
            for (JsonElement element : json.getAsJsonArray()) members.add(parseTeamProfile(element));
            TeamStateStore.setMembers(members);
            return members;
        });
    }

    public static CompletableFuture<Void> changeTeamRank(UUID memberId, TeamRank rank) {
        JsonObject body = new JsonObject();
        body.addProperty("rank", rank.id());
        // 001 remains a small self-managed event role. Every other rank is
        // only a request: the protected website must approve it first.
        if (rank != TeamRank.UNDERCOVER_001) {
            body.addProperty("targetId", memberId.toString());
            return post("/team/rank-requests", body).thenApply(ignored -> (Void) null);
        }
        return post("/team/members/" + memberId + "/rank", body).thenApply(ignored -> (Void) null);
    }

    public static CompletableFuture<Void> clearOwnUndercoverRank() {
        return delete("/team/me/event-rank").thenApply(ignored -> (Void) null);
    }

    /** Sends one message to the private MPSQ Team chat. */
    public static CompletableFuture<Void> sendTeamMessage(String message) {
        JsonObject body = new JsonObject();
        body.addProperty("message", message);
        return post("/team/chat", body).thenApply(ignored -> (Void) null);
    }

    public static CompletableFuture<List<TeamChatMessage>> loadTeamMessages() {
        return get("/team/chat").thenApply(json -> {
            List<TeamChatMessage> messages = new ArrayList<>();
            if (!json.isJsonArray()) return messages;
            for (JsonElement element : json.getAsJsonArray()) {
                JsonObject row = element.getAsJsonObject();
                messages.add(new TeamChatMessage(
                        row.has("sender_name") ? row.get("sender_name").getAsString() : "MPSQ Team",
                        TeamRank.fromId(row.has("sender_rank") ? row.get("sender_rank").getAsString() : "spieler"),
                        row.has("message") ? row.get("message").getAsString() : ""));
            }
            return messages;
        });
    }

    public static CompletableFuture<List<TeamTodo>> loadTeamTodos() {
        return get("/team/todos").thenApply(json -> {
            List<TeamTodo> todos = new ArrayList<>();
            if (!json.isJsonArray()) return todos;
            for (JsonElement element : json.getAsJsonArray()) {
                JsonObject row = element.getAsJsonObject();
                todos.add(new TeamTodo(UUID.fromString(row.get("id").getAsString()), row.get("text").getAsString(),
                        row.has("done") && row.get("done").getAsBoolean()));
            }
            return todos;
        });
    }

    public static CompletableFuture<Void> addTeamTodo(String text) {
        JsonObject body = new JsonObject(); body.addProperty("text", text);
        return post("/team/todos", body).thenApply(ignored -> (Void) null);
    }

    public static CompletableFuture<Void> toggleTeamTodo(UUID id, boolean done) {
        JsonObject body = new JsonObject(); body.addProperty("done", done);
        return patch("/team/todos/" + id, body).thenApply(ignored -> (Void) null);
    }

    public static CompletableFuture<TeamTimerState> loadTeamTimer() {
        return get("/team/timer").thenApply(json -> {
            JsonObject row = json.getAsJsonObject();
            return new TeamTimerState(row.has("running") && row.get("running").getAsBoolean(),
                    row.has("ends_at") && !row.get("ends_at").isJsonNull() ? row.get("ends_at").getAsString() : null,
                    row.has("label") ? row.get("label").getAsString() : "");
        });
    }

    public static CompletableFuture<Void> updateTeamTimer(boolean running, long durationSeconds, String label) {
        JsonObject body = new JsonObject();
        body.addProperty("running", running); body.addProperty("durationSeconds", durationSeconds); body.addProperty("label", label);
        return post("/team/timer", body).thenApply(ignored -> (Void) null);
    }

    public static CompletableFuture<List<TeamTemplate>> loadTeamTemplates() {
        return get("/team/templates").thenApply(json -> {
            List<TeamTemplate> templates = new ArrayList<>();
            if (!json.isJsonArray()) return templates;
            for (JsonElement element : json.getAsJsonArray()) {
                JsonObject row = element.getAsJsonObject();
                templates.add(new TeamTemplate(UUID.fromString(row.get("id").getAsString()), row.get("text").getAsString()));
            }
            return templates;
        });
    }

    public static CompletableFuture<Void> addTeamTemplate(String text) {
        JsonObject body = new JsonObject(); body.addProperty("text", text);
        return post("/team/templates", body).thenApply(ignored -> (Void) null);
    }

    private static TeamProfile parseTeamProfile(JsonElement json) {
        JsonObject row = json.getAsJsonObject();
        UUID id = UUID.fromString(row.get("id").getAsString());
        String name = row.has("display_name") ? row.get("display_name").getAsString() : "Minecraft Spieler";
        TeamRank base = TeamRank.fromId(row.has("base_rank") ? row.get("base_rank").getAsString() : "spieler");
        TeamRank active = row.has("active_rank") && !row.get("active_rank").isJsonNull()
                ? TeamRank.fromId(row.get("active_rank").getAsString()) : null;
        return new TeamProfile(id, name, base, active);
    }

    private static CompletableFuture<JsonElement> request(String method, String path, JsonObject body, boolean authenticated) {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(API_URL + path)).timeout(Duration.ofSeconds(15)).header("Accept", "application/json");
        if (authenticated) {
            if (token == null || token.isBlank()) return CompletableFuture.failedFuture(new IllegalStateException("MPSQ ist nicht verbunden"));
            request.header("x-mpsq-token", token);
        }
        if (body == null) request.method(method, HttpRequest.BodyPublishers.noBody());
        else request.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(GSON.toJson(body)));
        return HTTP.sendAsync(request.build(), HttpResponse.BodyHandlers.ofString()).thenApply(response -> {
            JsonElement json = JsonParser.parseString(response.body());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                String message = json.isJsonObject() && json.getAsJsonObject().has("error") ? json.getAsJsonObject().get("error").getAsString() : response.body();
                MpsqCameraClient.LOGGER.warn("MPSQ-API {} {} fehlgeschlagen ({}): {}", method, path, response.statusCode(), message);
                throw new IllegalStateException(message);
            }
            return json;
        });
    }

    private static String readToken() {
        try { return Files.exists(TOKEN_FILE) ? Files.readString(TOKEN_FILE, StandardCharsets.UTF_8).trim() : null; }
        catch (IOException exception) { MpsqCameraClient.LOGGER.warn("MPSQ-Zugang konnte nicht gelesen werden", exception); return null; }
    }

    private static String currentDisplayName() {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client != null && client.getSession() != null && !client.getSession().getUsername().isBlank()) {
            return client.getSession().getUsername();
        }
        return "Minecraft Client";
    }
}
