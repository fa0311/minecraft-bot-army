package botguard;

import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import net.kyori.adventure.text.Component;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerPreLoginEvent;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.Reader;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Collection;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Offline-mode guard: the bot army's names may only log in from this machine (loopback).
 * Anyone else joining under a bot's name would make Paper kick the real bot and hand the impostor its inventory.
 * Protected names = keys of the roster JSON (bots/assignments.json), re-read at most every 60 s, plus config `extra`.
 * No commands, nothing else is touched.
 */
public final class BotGuard extends JavaPlugin implements Listener {
    static final long REFRESH_MS = 60_000L;
    static final String KICK_MESSAGE = "This name is reserved.";

    private Path roster;
    /** IP PINNING (owner 09-19: somebody logged in AS the owner from 203.0.113.79; his own address is 192.168.69.1): name (lower case) -> networks it may come from */
    private java.util.Map<String, java.util.List<String>> pinned = java.util.Map.of();
    private Set<String> extra = Set.of();
    private volatile Set<String> names = Set.of();
    private volatile long loadedAt = 0L;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        roster = Paths.get(getConfig().getString("roster", "/root/workspace/bots/assignments.json"));
        extra = lower(getConfig().getStringList("extra"));
        names = protectedNames();
        java.util.Map<String, java.util.List<String>> pin = new java.util.HashMap<>();
        org.bukkit.configuration.ConfigurationSection sec = getConfig().getConfigurationSection("pinned");
        if (sec != null) for (String k : sec.getKeys(false)) pin.put(k.toLowerCase(Locale.ROOT), sec.getStringList(k));
        pinned = pin;
        getLogger().info("IP-pinned names: " + pinned);
        getServer().getPluginManager().registerEvents(this, this);
        getLogger().info("protecting " + names.size() + " names (roster " + roster + "); they may only log in from loopback");
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onPreLogin(AsyncPlayerPreLoginEvent e) {
        if (isPinnedAway(e.getName(), e.getAddress(), pinned)) {
            e.disallow(AsyncPlayerPreLoginEvent.Result.KICK_OTHER, Component.text(KICK_MESSAGE));
            getLogger().warning("blocked login as IP-pinned name '" + e.getName() + "' from " + e.getAddress().getHostAddress());
            return;
        }
        if (!isBlocked(e.getName(), e.getAddress(), protectedNames())) return;
        e.disallow(AsyncPlayerPreLoginEvent.Result.KICK_OTHER, Component.text(KICK_MESSAGE));
        getLogger().warning("blocked login as reserved name '" + e.getName() + "' from " + e.getAddress().getHostAddress());
    }

    /** the whole decision: a protected name (case-insensitive) from a non-loopback address */
    static boolean isBlocked(String name, InetAddress addr, Set<String> protectedLower) {
        if (name == null || !protectedLower.contains(name.toLowerCase(Locale.ROOT))) return false;
        return addr == null || !addr.isLoopbackAddress(); // 127.0.0.0/8, ::1 (and ::ffff:127.x, which Java maps to IPv4)
    }

    /** a pinned name from an address outside ALL of its networks (IPv4 CIDR like 192.168.0.0/16, or an exact address); unpinned names pass */
    static boolean isPinnedAway(String name, InetAddress addr, java.util.Map<String, java.util.List<String>> pinned) {
        if (name == null) return false;
        java.util.List<String> nets = pinned.get(name.toLowerCase(Locale.ROOT));
        if (nets == null || nets.isEmpty()) return false;
        if (addr == null) return true;
        for (String n : nets) if (inNet(addr, n)) return false;
        return true;
    }

    static boolean inNet(InetAddress addr, String net) {
        try {
            String[] p = net.trim().split("/");
            InetAddress base = InetAddress.getByName(p[0]);
            byte[] a = addr.getAddress(), b = base.getAddress();
            if (a.length != b.length) return false;
            int bits = p.length > 1 ? Integer.parseInt(p[1]) : a.length * 8;
            for (int i = 0; i < a.length && bits > 0; i++, bits -= 8) {
                int mask = bits >= 8 ? 0xFF : (0xFF << (8 - bits)) & 0xFF;
                if ((a[i] & mask) != (b[i] & mask)) return false;
            }
            return true;
        } catch (Exception e) { return false; }
    }

    /** roster keys + extra, lower-cased; re-read at most every 60 s; on a read error the last good list stays in force */
    private Set<String> protectedNames() {
        long now = System.currentTimeMillis();
        if (now - loadedAt < REFRESH_MS) return names;
        synchronized (this) {
            if (now - loadedAt < REFRESH_MS) return names;
            loadedAt = now;
            try {
                Set<String> s = readRoster(roster);
                s.addAll(extra);
                names = s;
            } catch (Exception ex) {
                getLogger().warning("cannot read roster " + roster + " (" + ex + ") - keeping the last " + names.size() + " names");
                if (names.isEmpty()) names = new HashSet<>(extra);
            }
            return names;
        }
    }

    static Set<String> readRoster(Path file) throws Exception {
        try (Reader r = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            JsonElement root = JsonParser.parseReader(r);
            return lower(root.getAsJsonObject().keySet());
        }
    }

    static Set<String> lower(Collection<String> in) {
        Set<String> out = new HashSet<>();
        if (in != null) for (String s : in) if (s != null && !s.isBlank()) out.add(s.trim().toLowerCase(Locale.ROOT));
        return out;
    }
}
