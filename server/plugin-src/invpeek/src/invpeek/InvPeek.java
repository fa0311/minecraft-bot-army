package invpeek;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryCloseEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.inventory.EquipmentSlot;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * InvPeek - RIGHT-CLICK a player (the bots are players) to LOOK into its inventory. Read-only by construction: the window shows COPIES of the
 * items, every click/drag in it is cancelled, nothing is ever written back. No op, no permission. Fallback command: /inv <name>.
 * Layout (6 rows): rows 1-3 = main inventory, row 4 = hotbar, row 5 = helmet chestplate leggings boots | off-hand | hp/food info.
 * The view refreshes twice a second, so you can watch a bot work.
 */
public final class InvPeek extends JavaPlugin implements Listener {
  private static final class Holder implements InventoryHolder {
    final UUID target; Inventory inv;
    Holder(UUID target) { this.target = target; }
    @Override public Inventory getInventory() { return inv; }
  }

  private final Map<UUID, Holder> open = new HashMap<>();

  @Override public void onEnable() {
    Bukkit.getPluginManager().registerEvents(this, this);
    Bukkit.getScheduler().runTaskTimer(this, this::refreshAll, 10L, 10L);
  }

  @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = false)
  public void onInteract(PlayerInteractEntityEvent e) {
    if (e.getHand() != EquipmentSlot.HAND || !(e.getRightClicked() instanceof Player target)) return;
    e.setCancelled(true);
    show(e.getPlayer(), target);
  }

  @Override public boolean onCommand(CommandSender sender, Command cmd, String label, String[] args) {
    if (!(sender instanceof Player viewer)) { sender.sendMessage("players only"); return true; }
    if (args.length != 1) return false;
    Player target = Bukkit.getPlayerExact(args[0]);
    if (target == null) { viewer.sendMessage(Component.text(args[0] + " is not online", NamedTextColor.RED)); return true; }
    show(viewer, target);
    return true;
  }

  private void show(Player viewer, Player target) {
    Holder h = new Holder(target.getUniqueId());
    h.inv = Bukkit.createInventory(h, 54, Component.text(target.getName() + " の持ち物（閲覧のみ）"));
    fill(h.inv, target);
    viewer.openInventory(h.inv);
    open.put(viewer.getUniqueId(), h);
  }

  private static ItemStack copy(ItemStack s) { return s == null ? null : s.clone(); }

  private static void fill(Inventory gui, Player t) {
    PlayerInventory p = t.getInventory();
    for (int i = 9; i <= 35; i++) gui.setItem(i - 9, copy(p.getItem(i)));      // main inventory -> rows 1-3
    for (int i = 0; i <= 8; i++) gui.setItem(27 + i, copy(p.getItem(i)));      // hotbar -> row 4
    gui.setItem(36, copy(p.getHelmet())); gui.setItem(37, copy(p.getChestplate()));
    gui.setItem(38, copy(p.getLeggings())); gui.setItem(39, copy(p.getBoots()));
    gui.setItem(41, copy(p.getItemInOffHand()));
    ItemStack info = new ItemStack(Material.PAPER);
    ItemMeta m = info.getItemMeta();
    m.displayName(Component.text(t.getName(), NamedTextColor.AQUA));
    m.lore(java.util.List.of(
      Component.text("HP " + Math.round(t.getHealth()) + " / 20   food " + t.getFoodLevel() + " / 20", NamedTextColor.GRAY),
      Component.text("xyz " + t.getLocation().getBlockX() + " " + t.getLocation().getBlockY() + " " + t.getLocation().getBlockZ(), NamedTextColor.GRAY),
      Component.text("held slot " + (p.getHeldItemSlot() + 1), NamedTextColor.GRAY)));
    info.setItemMeta(m);
    gui.setItem(44, info);
  }

  private void refreshAll() {
    open.entrySet().removeIf(en -> {
      Player viewer = Bukkit.getPlayer(en.getKey());
      Player target = Bukkit.getPlayer(en.getValue().target);
      if (viewer == null || viewer.getOpenInventory().getTopInventory().getHolder() != en.getValue()) return true;
      if (target == null) { viewer.closeInventory(); return true; }
      fill(en.getValue().inv, target);
      return false;
    });
  }

  @EventHandler(priority = EventPriority.LOWEST)
  public void onClick(InventoryClickEvent e) { if (e.getView().getTopInventory().getHolder() instanceof Holder) e.setCancelled(true); }

  @EventHandler(priority = EventPriority.LOWEST)
  public void onDrag(InventoryDragEvent e) { if (e.getView().getTopInventory().getHolder() instanceof Holder) e.setCancelled(true); }

  @EventHandler public void onClose(InventoryCloseEvent e) { if (e.getInventory().getHolder() instanceof Holder) open.remove(e.getPlayer().getUniqueId()); }

  @EventHandler public void onQuit(PlayerQuitEvent e) { open.remove(e.getPlayer().getUniqueId()); }
}
