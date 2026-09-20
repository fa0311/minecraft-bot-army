package botguard;

import java.net.InetAddress;
import java.nio.file.Paths;
import java.util.Set;

/** not packaged: run by build.sh (needs the libraries classpath: BotGuard extends JavaPlugin) */
public final class BotGuardTest {
    public static void main(String[] a) throws Exception {
        Set<String> names = BotGuard.readRoster(Paths.get(a.length > 0 ? a[0] : "/root/workspace/bots/assignments.json"));
        names.addAll(BotGuard.lower(java.util.List.of("ExtraName")));
        System.out.println("roster names: " + names.size());
        int bad = 0;
        bad += check("Sakura from 127.0.0.1", BotGuard.isBlocked("Sakura", InetAddress.getByName("127.0.0.1"), names), false);
        bad += check("Sakura from 127.8.9.10", BotGuard.isBlocked("Sakura", InetAddress.getByName("127.8.9.10"), names), false);
        bad += check("Sakura from ::1", BotGuard.isBlocked("Sakura", InetAddress.getByName("::1"), names), false);
        bad += check("Sakura from ::ffff:127.0.0.1", BotGuard.isBlocked("Sakura", InetAddress.getByName("::ffff:127.0.0.1"), names), false);
        bad += check("Sakura from 192.168.1.20", BotGuard.isBlocked("Sakura", InetAddress.getByName("192.168.1.20"), names), true);
        bad += check("sAkUrA from 203.0.113.7", BotGuard.isBlocked("sAkUrA", InetAddress.getByName("203.0.113.7"), names), true);
        bad += check("SAKURA from 2001:db8::1", BotGuard.isBlocked("SAKURA", InetAddress.getByName("2001:db8::1"), names), true);
        bad += check("extraname from 10.0.0.1", BotGuard.isBlocked("extraname", InetAddress.getByName("10.0.0.1"), names), true);
        bad += check("fa0311 from 203.0.113.7", BotGuard.isBlocked("fa0311", InetAddress.getByName("203.0.113.7"), names), false);
        bad += check("Sakura_ from 203.0.113.7", BotGuard.isBlocked("Sakura_", InetAddress.getByName("203.0.113.7"), names), false);
        bad += check("protected name, null address", BotGuard.isBlocked("Sakura", null, names), true);
        bad += check("null name", BotGuard.isBlocked(null, InetAddress.getByName("203.0.113.7"), names), false);
        java.util.Map<String, java.util.List<String>> pin = java.util.Map.of("fa0311", java.util.List.of("192.168.0.0/16", "127.0.0.0/8"));
        bad += check("PIN fa0311 from 192.168.69.1", BotGuard.isPinnedAway("fa0311", InetAddress.getByName("192.168.69.1"), pin), false);
        bad += check("PIN FA0311 from 192.168.200.9", BotGuard.isPinnedAway("FA0311", InetAddress.getByName("192.168.200.9"), pin), false);
        bad += check("PIN fa0311 from 127.0.0.1", BotGuard.isPinnedAway("fa0311", InetAddress.getByName("127.0.0.1"), pin), false);
        bad += check("PIN fa0311 from 203.0.113.79", BotGuard.isPinnedAway("fa0311", InetAddress.getByName("203.0.113.79"), pin), true);
        bad += check("PIN fa0311 from 192.169.0.1", BotGuard.isPinnedAway("fa0311", InetAddress.getByName("192.169.0.1"), pin), true);
        bad += check("PIN fa0311 from 2001:db8::1", BotGuard.isPinnedAway("fa0311", InetAddress.getByName("2001:db8::1"), pin), true);
        bad += check("STORE chest inside the box", BotGuard.isStore("CHEST", -360, -500, new int[]{-416, -567, -222, -361}), true);
        bad += check("STORE chest outside the box", BotGuard.isStore("CHEST", 0, 0, new int[]{-416, -567, -222, -361}), false);
        bad += check("STORE dirt is no store", BotGuard.isStore("DIRT", -360, -500, new int[]{-416, -567, -222, -361}), false);
        bad += check("STORE off without a box", BotGuard.isStore("CHEST", -360, -500, null), false);
        bad += check("PIN Stranger (unpinned) from 203.0.113.79", BotGuard.isPinnedAway("Stranger", InetAddress.getByName("203.0.113.79"), pin), false);
        System.out.println(bad == 0 ? "ALL OK" : bad + " FAILED");
        System.exit(bad == 0 ? 0 : 1);
    }
    static int check(String what, boolean got, boolean want) {
        System.out.println((got == want ? "ok   " : "FAIL ") + what + " -> " + (got ? "BLOCKED" : "allowed"));
        return got == want ? 0 : 1;
    }
}
