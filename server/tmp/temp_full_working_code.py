
"""
Tile-based A* pathfinding helper for Pokemon FireRed-style overworld grids.

This module is designed for the "path_to_location" assistant workflow:
- Loads a 2D grid (list of rows) from a JSON file.
- Plans a path from (x,y) start to (x,y) goal as directional key presses:
  ['up','down','left','right'].

Core mechanics supported:
- Collision tiles (walls, NPCs, interactives, trees, boulders, doors, warps, etc.)
- Fog-of-war tiles encoded as None (treated as passable with high cost)
- Tall grass higher cost
- One-way ledges with +1 displacement (entering a ledge moves an extra tile)
- Edge-blocked floor tiles (IDs 68-75) that forbid entry from certain sides
- Two-pass interactive obstacle feasibility checks (trees, boulders, water, NPCs,
  locked doors, teleporters/warps), returning a "stop before obstacle" path when needed.

The goal tile is always allowed for reachability evaluation, even if it would
normally be blocked (e.g., if the goal itself is a door/warp tile).
However, intermediate warps/doors are blocked for safety.

Typical usage (as a library):
    keys, meta = plan_path(
        grid_path="/mnt/data/map.json",
        start=(26, 27),
        goal=(25, 39),
        strength=False,
        movement_mode="WALK",   # or "SURF"
    )

The `meta` dict contains debug details to help explain why a path stops early.
"""

from __future__ import annotations

import json
import heapq
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple, Iterable, Any, Set

Coord = Tuple[int, int]
Keys = List[str]

# --- Tile IDs from legend (subset used; unknown tiles are encoded as None in the grid) ---
WALL = 0
FREE = 1
TALL_GRASS = 2
WATER = 3
WARP = 9
NPC = 10
INTERACTIVE = 11
# Common interior objects (collision)
PC = 14
REGION_MAP = 15
TELEVISION = 16
BOOKSHELF = 18
TRASH_CAN = 21
SHOP_SHELF = 22
ITEM_BALL = 55
OOB_COLLISION = 25
BREAKABLE_ROCK = 36
TEMP_WALL = 66
DOOR = 26
LADDER = 27
ESCALATOR = 28
HOLE = 29
STAIRS = 30
ENTRANCE = 31
WARP_ARROW = 32
BOULDER = 33
TREE = 35
LOCKED_DOOR = 67

# Ledges
LEDGE_EAST = 5
LEDGE_WEST = 6
LEDGE_NORTH = 7
LEDGE_SOUTH = 8

# Edge-blocked floor tiles (entry restrictions)
BLOCK_N = 68
BLOCK_S = 69
BLOCK_E = 70
BLOCK_W = 71
BLOCK_NE = 72
BLOCK_NW = 73
BLOCK_SE = 74
BLOCK_SW = 75

# Other passable specials (treated as "other passable")
RED_CARPET = 23
OOB_WALKABLE = 24
ARROW_LEFT = 44
ARROW_RIGHT = 45
ARROW_UP = 46
ARROW_DOWN = 47
CRACKED_FLOOR = 140

DIRS: Dict[str, Tuple[int, int]] = {
    "up": (0, -1),
    "down": (0, 1),
    "left": (-1, 0),
    "right": (1, 0),
}

# For ledges, the forced movement direction
LEDGE_DIR: Dict[int, Tuple[int, int]] = {
    LEDGE_EAST: (1, 0),
    LEDGE_WEST: (-1, 0),
    LEDGE_NORTH: (0, -1),
    LEDGE_SOUTH: (0, 1),
}

# Tiles that may warp to another map; avoid stepping on them unless they are the goal.
WARP_LIKE: Set[int] = {WARP, DOOR, LADDER, ESCALATOR, HOLE, STAIRS, ENTRANCE, WARP_ARROW}

# Tiles that are "normally passable floor" (cost 1) besides FREE
FLOOR_LIKE: Set[int] = {FREE, RED_CARPET, OOB_WALKABLE, ARROW_LEFT, ARROW_RIGHT, ARROW_UP, ARROW_DOWN, CRACKED_FLOOR,
                        BLOCK_N, BLOCK_S, BLOCK_E, BLOCK_W, BLOCK_NE, BLOCK_NW, BLOCK_SE, BLOCK_SW}

PASSABLE_OTHER: Set[int] = set()  # placeholder for any other discovered passables


# Tiles that are always impassable regardless of abilities/mode (except when goal is on them).
STATIC_COLLISION_TILES: Set[int] = {
    WALL,
    NPC,
    INTERACTIVE,
    TREE,
    LOCKED_DOOR,
    SHOP_SHELF,
    PC,
    REGION_MAP,
    TELEVISION,
    BOOKSHELF,
    TRASH_CAN,
    ITEM_BALL,
    BREAKABLE_ROCK,
    TEMP_WALL,
    OOB_COLLISION,
}


def load_grid(path: str) -> List[List[Optional[int]]]:
    """Load a grid JSON file containing rows of tile IDs or None."""
    with open(path, "r") as f:
        return json.load(f)


def in_bounds(grid: List[List[Optional[int]]], c: Coord) -> bool:
    x, y = c
    return 0 <= y < len(grid) and 0 <= x < len(grid[0])


def tile_at(grid: List[List[Optional[int]]], c: Coord) -> Optional[int]:
    x, y = c
    return grid[y][x]


def manhattan(a: Coord, b: Coord) -> int:
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def movement_cost(tile: Optional[int]) -> int:
    """Movement cost biasing safer tiles."""
    if tile is None:
        return 50  # unexplored (fog-of-war)
    if tile == FREE or tile in FLOOR_LIKE:
        return 1
    if tile == TALL_GRASS:
        return 25
    # Any other passable tile (e.g., special floors)
    return 10


def blocked_by_default(tile: Optional[int], *, strength: bool, movement_mode: str) -> bool:
    """
    Strict collision test (excluding warps/goal handling).

    Notes:
    - Warps/doors/stairs/etc. are handled separately via `is_warp_like()` because we avoid
      stepping on them unless they are the destination.
    - Water is blocked in WALK mode (land->water requires manual Surf activation).
    - Boulders are blocked unless Strength is active (this module only uses Strength for
      feasibility checks; it does not plan pushes).
    """
    if tile is None:
        return False  # fog-of-war treated as passable (high cost)

    # Always-blocked (static) collision tiles
    if tile in STATIC_COLLISION_TILES:
        return True

    # Conditional blockers
    if tile == BOULDER and not strength:
        return True
    if tile == WATER and movement_mode != "SURF":
        return True

    return False


def is_warp_like(tile: Optional[int]) -> bool:
    return tile in WARP_LIKE if tile is not None else False


def entry_blocked(tile: Optional[int], move_dir: str) -> bool:
    """
    Return True if 'tile' forbids entering from the side implied by move_dir.

    move_dir is the direction you press to move into the tile:
    - 'down' means entering from north side
    - 'up' means entering from south side
    - 'right' means entering from west side
    - 'left' means entering from east side
    """
    if tile is None:
        return False
    entering_from = {
        "down": "N",
        "up": "S",
        "right": "W",
        "left": "E",
    }[move_dir]

    if tile == BLOCK_N and entering_from == "N":
        return True
    if tile == BLOCK_S and entering_from == "S":
        return True
    if tile == BLOCK_E and entering_from == "E":
        return True
    if tile == BLOCK_W and entering_from == "W":
        return True
    if tile == BLOCK_NE and entering_from in ("N", "E"):
        return True
    if tile == BLOCK_NW and entering_from in ("N", "W"):
        return True
    if tile == BLOCK_SE and entering_from in ("S", "E"):
        return True
    if tile == BLOCK_SW and entering_from in ("S", "W"):
        return True
    return False


def apply_move_with_ledge(
    grid: List[List[Optional[int]]],
    cur: Coord,
    move_dir: str,
    *,
    strength: bool,
    movement_mode: str,
    goal: Coord,
    allow_warp_tiles: bool = False,
    extra_blocked: Optional[Set[int]] = None,
) -> Optional[Coord]:
    """
    Compute the resulting coordinate after pressing move_dir from cur.
    Handles ledges as "+1 displacement" in their direction.

    Returns None if the move is not possible due to collision/entry restrictions.
    """
    extra_blocked = extra_blocked or set()
    dx, dy = DIRS[move_dir]
    nxt = (cur[0] + dx, cur[1] + dy)
    if not in_bounds(grid, nxt):
        return None

    t1 = tile_at(grid, nxt)

    # Safety: don't step on warp-like tiles unless they are the goal (or allow_warp_tiles for simulation)
    if nxt != goal and (not allow_warp_tiles) and is_warp_like(t1):
        return None

    # Entry restrictions
    if entry_blocked(t1, move_dir):
        return None

    # Extra blocked types (simulation toggles)
    if t1 is not None and t1 in extra_blocked and nxt != goal:
        return None

    # Collision (strict passability)
    if nxt != goal and blocked_by_default(t1, strength=strength, movement_mode=movement_mode):
        return None

    # Ledge handling: stepping onto a ledge forces an extra move
    if t1 in LEDGE_DIR:
        ldx, ldy = LEDGE_DIR[t1]
        # Must be moving in the ledge's direction to enter it
        if (dx, dy) != (ldx, ldy):
            return None
        land = (nxt[0] + ldx, nxt[1] + ldy)
        if not in_bounds(grid, land):
            return None
        t2 = tile_at(grid, land)

        if land != goal and (not allow_warp_tiles) and is_warp_like(t2):
            return None
        if entry_blocked(t2, move_dir):
            # After the forced movement, you are "entering" the landing tile from the same side
            return None
        if t2 is not None and t2 in extra_blocked and land != goal:
            return None
        if land != goal and blocked_by_default(t2, strength=strength, movement_mode=movement_mode):
            return None
        return land

    return nxt


@dataclass(order=True)
class PQNode:
    f: int
    g: int
    c: Coord


def astar_path(
    grid: List[List[Optional[int]]],
    start: Coord,
    goal: Coord,
    *,
    strength: bool,
    movement_mode: str,
    allow_warp_tiles: bool,
    extra_blocked: Optional[Set[int]] = None,
) -> Optional[Keys]:
    """A* returning a list of key presses, or None if unreachable."""
    if start == goal:
        return []

    openpq: List[PQNode] = []
    heapq.heappush(openpq, PQNode(manhattan(start, goal), 0, start))
    came_from: Dict[Coord, Tuple[Coord, str]] = {}
    gscore: Dict[Coord, int] = {start: 0}

    while openpq:
        node = heapq.heappop(openpq)
        cur = node.c

        if cur == goal:
            # reconstruct keys
            keys: Keys = []
            while cur != start:
                prev, k = came_from[cur]
                keys.append(k)
                cur = prev
            keys.reverse()
            return keys

        if node.g != gscore.get(cur, 10**18):
            continue

        for k in ("up", "down", "left", "right"):
            nxt = apply_move_with_ledge(
                grid, cur, k,
                strength=strength,
                movement_mode=movement_mode,
                goal=goal,
                allow_warp_tiles=allow_warp_tiles,
                extra_blocked=extra_blocked,
            )
            if nxt is None:
                continue

            # cost is based on the tile you land on (goal allowed even if normally blocked)
            step_cost = movement_cost(tile_at(grid, nxt))
            ng = node.g + step_cost
            if ng < gscore.get(nxt, 10**18):
                gscore[nxt] = ng
                came_from[nxt] = (cur, k)
                nf = ng + manhattan(nxt, goal)
                heapq.heappush(openpq, PQNode(nf, ng, nxt))
    return None


def replay_positions(grid: List[List[Optional[int]]], start: Coord, keys: Keys, *, strength: bool, movement_mode: str, goal: Coord) -> List[Coord]:
    """Recompute the visited positions (including start) following `keys` using strict ledge mechanics."""
    pos = start
    out = [pos]
    for k in keys:
        nxt = apply_move_with_ledge(grid, pos, k, strength=strength, movement_mode=movement_mode, goal=goal, allow_warp_tiles=True)
        if nxt is None:
            # Shouldn't happen if keys came from astar_path, but keep safe.
            break
        pos = nxt
        out.append(pos)
    return out


def first_obstacle_on_route(
    grid: List[List[Optional[int]]],
    start: Coord,
    keys: Keys,
    obstacle_tile_ids: Set[int],
    *,
    strength: bool,
    movement_mode: str,
    goal: Coord,
) -> Optional[Tuple[Coord, Coord, str, int]]:
    """
    Find the first step that would land on an obstacle tile (by ID) along a simulated route.

    Returns (prev_coord, obstacle_coord, move_dir, obstacle_tile_id).
    """
    pos = start
    for k in keys:
        dx, dy = DIRS[k]
        nxt = (pos[0] + dx, pos[1] + dy)
        if not in_bounds(grid, nxt):
            return None
        t1 = tile_at(grid, nxt)

        # ledge: obstacle could be on the ledge tile itself or the landing tile; check both
        if t1 in obstacle_tile_ids:
            return (pos, nxt, k, t1)

        if t1 in LEDGE_DIR:
            ldx, ldy = LEDGE_DIR[t1]
            land = (nxt[0] + ldx, nxt[1] + ldy)
            if not in_bounds(grid, land):
                return None
            t2 = tile_at(grid, land)
            if t2 in obstacle_tile_ids:
                return (nxt, land, k, t2)
            pos = land
        else:
            pos = nxt
    return None


def plan_path(
    grid_path: str,
    start: Coord,
    goal: Coord,
    *,
    strength: bool = False,
    movement_mode: str = "WALK",
) -> Tuple[Keys, Dict[str, Any]]:
    """
    Plan a path following the priority order:
    1) Strict pathfinding
    2) Simulation passes (trees, boulders, water, NPC, locked door, warp)
    3) Proximity fallback (within 1 tile)
    4) No route

    Returns (keys, meta).
    """
    grid = load_grid(grid_path)
    meta: Dict[str, Any] = {
        "start": start,
        "goal": goal,
        "movement_mode": movement_mode,
        "strength": strength,
        "passes": [],
    }

    def run_pass(name: str, *, allow_tiles: Set[int] = set(), allow_warp_tiles: bool = False, sim_movement_mode: Optional[str] = None) -> Optional[Keys]:
        """Run A* with specific tiles allowed (removed from blocked set)."""
        # We model "allow tiles" by adding everything else to extra_blocked,
        # but that's cumbersome; instead we keep strict collision and use extra_blocked
        # only for tiles we want to force-block additionally. For simulation passes we
        # temporarily *relax* default collision by changing strength/mode or checking separately.
        # Here: allow_tiles impacts blocked_by_default via special-case in apply_move_with_ledge
        # isn't directly supported; we handle simulation via temporarily tweaking parameters.

        mode = sim_movement_mode or movement_mode
        # For allow_tiles, we implement by passing a special extra_blocked set that blocks nothing,
        # and by overriding blocked_by_default in-line is messy.
        # Simpler: for each pass we adjust "strength/mode" and then treat certain tiles as floor
        # by intercepting blocked_by_default via a wrapper.
        return astar_path_custom(
            grid, start, goal,
            strength=strength,
            movement_mode=mode,
            allow_tiles=allow_tiles,
            allow_warp_tiles=allow_warp_tiles,
        )

    # Custom A* that can temporarily treat some normally-blocked tiles as passable
    def is_blocked(tile: Optional[int], coord: Coord, *, allow_tiles: Set[int], strength_: bool, mode_: str) -> bool:
        if coord == goal:
            return False
        if tile is None:
            return False
        if tile in allow_tiles:
            # still don't allow warp-like unless allow_warp_tiles enabled at neighbor gen
            return False
        return blocked_by_default(tile, strength=strength_, movement_mode=mode_)

    def astar_path_custom(
        grid: List[List[Optional[int]]],
        start: Coord,
        goal: Coord,
        *,
        strength: bool,
        movement_mode: str,
        allow_tiles: Set[int],
        allow_warp_tiles: bool,
    ) -> Optional[Keys]:
        """A* variant allowing specific tile IDs to be treated as passable for feasibility simulation."""
        if start == goal:
            return []
        openpq: List[PQNode] = []
        heapq.heappush(openpq, PQNode(manhattan(start, goal), 0, start))
        came_from: Dict[Coord, Tuple[Coord, str]] = {}
        gscore: Dict[Coord, int] = {start: 0}

        while openpq:
            node = heapq.heappop(openpq)
            cur = node.c
            if cur == goal:
                keys: Keys = []
                while cur != start:
                    prev, k = came_from[cur]
                    keys.append(k)
                    cur = prev
                keys.reverse()
                return keys

            if node.g != gscore.get(cur, 10**18):
                continue

            for k in ("up", "down", "left", "right"):
                dx, dy = DIRS[k]
                nxt = (cur[0] + dx, cur[1] + dy)
                if not in_bounds(grid, nxt):
                    continue
                t1 = tile_at(grid, nxt)

                if nxt != goal and (not allow_warp_tiles) and is_warp_like(t1):
                    continue
                if entry_blocked(t1, k):
                    continue
                if is_blocked(t1, nxt, allow_tiles=allow_tiles, strength_=strength, mode_=movement_mode):
                    continue

                # ledge
                if t1 in LEDGE_DIR:
                    ldx, ldy = LEDGE_DIR[t1]
                    if (dx, dy) != (ldx, ldy):
                        continue
                    land = (nxt[0] + ldx, nxt[1] + ldy)
                    if not in_bounds(grid, land):
                        continue
                    t2 = tile_at(grid, land)
                    if land != goal and (not allow_warp_tiles) and is_warp_like(t2):
                        continue
                    if entry_blocked(t2, k):
                        continue
                    if is_blocked(t2, land, allow_tiles=allow_tiles, strength_=strength, mode_=movement_mode):
                        continue
                    nxt2 = land
                else:
                    nxt2 = nxt

                step_cost = movement_cost(tile_at(grid, nxt2))
                ng = node.g + step_cost
                if ng < gscore.get(nxt2, 10**18):
                    gscore[nxt2] = ng
                    came_from[nxt2] = (cur, k)
                    nf = ng + manhattan(nxt2, goal)
                    heapq.heappush(openpq, PQNode(nf, ng, nxt2))
        return None

    # --- 1) Strict pathfinding ---
    strict_keys = astar_path_custom(
        grid, start, goal,
        strength=strength,
        movement_mode=movement_mode,
        allow_tiles=set(),
        allow_warp_tiles=False,
    )
    meta["passes"].append({"name": "strict", "found": strict_keys is not None, "allow_tiles": []})
    if strict_keys is not None:
        return strict_keys, meta

    # --- 2) Simulation passes in required order ---
    # 2.1 Trees (Cut)
    sim = astar_path_custom(grid, start, goal, strength=strength, movement_mode=movement_mode, allow_tiles={TREE}, allow_warp_tiles=False)
    meta["passes"].append({"name": "sim_cut_tree", "found": sim is not None, "allow_tiles": [TREE]})
    if sim is not None:
        info = first_obstacle_on_route(grid, start, sim, {TREE}, strength=strength, movement_mode=movement_mode, goal=goal)
        if info:
            prev, obstacle, move_dir, tid = info
            stop = prev
            p_stop = astar_path_custom(grid, start, stop, strength=strength, movement_mode=movement_mode, allow_tiles=set(), allow_warp_tiles=False) or []
            meta["stop_reason"] = "Cut required"
            meta["stop_tile"] = stop
            meta["blocking_tile"] = obstacle
            meta["blocking_tile_id"] = tid
            meta["facing"] = move_dir
            return p_stop, meta

    # 2.2 Boulders (Strength) when strength is False
    if not strength:
        sim = astar_path_custom(grid, start, goal, strength=True, movement_mode=movement_mode, allow_tiles=set(), allow_warp_tiles=False)
        # Above sim assumes Strength makes boulders passable (push planning not implemented);
        # it's a feasibility check only.
        meta["passes"].append({"name": "sim_strength_boulder", "found": sim is not None, "allow_tiles": ["(strength=True)"]})
        if sim is not None:
            info = first_obstacle_on_route(grid, start, sim, {BOULDER}, strength=True, movement_mode=movement_mode, goal=goal)
            if info:
                prev, obstacle, move_dir, tid = info
                stop = prev
                p_stop = astar_path_custom(grid, start, stop, strength=strength, movement_mode=movement_mode, allow_tiles=set(), allow_warp_tiles=False) or []
                meta["stop_reason"] = "Strength required"
                meta["stop_tile"] = stop
                meta["blocking_tile"] = obstacle
                meta["blocking_tile_id"] = tid
                meta["facing"] = move_dir
                return p_stop, meta

    # 2.3 Water barriers (Surf) when not surfing
    if movement_mode != "SURF":
        sim = astar_path_custom(grid, start, goal, strength=strength, movement_mode="SURF", allow_tiles=set(), allow_warp_tiles=False)
        meta["passes"].append({"name": "sim_surf_water", "found": sim is not None, "allow_tiles": ["(movement_mode=SURF)"]})
        if sim is not None:
            # find first land->water entry on simulated route
            pos = start
            for k in sim:
                dx, dy = DIRS[k]
                nxt = (pos[0] + dx, pos[1] + dy)
                if not in_bounds(grid, nxt):
                    break
                t1 = tile_at(grid, nxt)
                if t1 in LEDGE_DIR:
                    ldx, ldy = LEDGE_DIR[t1]
                    land = (nxt[0] + ldx, nxt[1] + ldy)
                    t_land = tile_at(grid, land) if in_bounds(grid, land) else None
                    # Treat "entering water" if the landing tile is water and current is not water
                    if t_land == WATER and tile_at(grid, pos) != WATER:
                        stop = pos
                        p_stop = astar_path_custom(grid, start, stop, strength=strength, movement_mode=movement_mode, allow_tiles=set(), allow_warp_tiles=False) or []
                        meta["stop_reason"] = "Surf required (land->water)"
                        meta["stop_tile"] = stop
                        meta["blocking_tile"] = land
                        meta["blocking_tile_id"] = WATER
                        meta["facing"] = k
                        return p_stop, meta
                    pos = land
                else:
                    if t1 == WATER and tile_at(grid, pos) != WATER:
                        stop = pos
                        p_stop = astar_path_custom(grid, start, stop, strength=strength, movement_mode=movement_mode, allow_tiles=set(), allow_warp_tiles=False) or []
                        meta["stop_reason"] = "Surf required (land->water)"
                        meta["stop_tile"] = stop
                        meta["blocking_tile"] = nxt
                        meta["blocking_tile_id"] = WATER
                        meta["facing"] = k
                        return p_stop, meta
                    pos = nxt

    # 2.4 NPC blocking
    sim = astar_path_custom(grid, start, goal, strength=strength, movement_mode=movement_mode, allow_tiles={NPC}, allow_warp_tiles=False)
    meta["passes"].append({"name": "sim_npc", "found": sim is not None, "allow_tiles": [NPC]})
    if sim is not None:
        info = first_obstacle_on_route(grid, start, sim, {NPC}, strength=strength, movement_mode=movement_mode, goal=goal)
        if info:
            prev, obstacle, move_dir, tid = info
            stop = prev
            p_stop = astar_path_custom(grid, start, stop, strength=strength, movement_mode=movement_mode, allow_tiles=set(), allow_warp_tiles=False) or []
            meta["stop_reason"] = "NPC blocking"
            meta["stop_tile"] = stop
            meta["blocking_tile"] = obstacle
            meta["blocking_tile_id"] = tid
            meta["facing"] = move_dir
            return p_stop, meta

    # 2.5 Locked door blocking
    sim = astar_path_custom(grid, start, goal, strength=strength, movement_mode=movement_mode, allow_tiles={LOCKED_DOOR}, allow_warp_tiles=False)
    meta["passes"].append({"name": "sim_locked_door", "found": sim is not None, "allow_tiles": [LOCKED_DOOR]})
    if sim is not None:
        info = first_obstacle_on_route(grid, start, sim, {LOCKED_DOOR}, strength=strength, movement_mode=movement_mode, goal=goal)
        if info:
            prev, obstacle, move_dir, tid = info
            stop = prev
            p_stop = astar_path_custom(grid, start, stop, strength=strength, movement_mode=movement_mode, allow_tiles=set(), allow_warp_tiles=False) or []
            meta["stop_reason"] = "Locked door blocking"
            meta["stop_tile"] = stop
            meta["blocking_tile"] = obstacle
            meta["blocking_tile_id"] = tid
            meta["facing"] = move_dir
            return p_stop, meta

    # 2.6 Teleporter/warp tile blocking (we treat WARP as the teleporter tile)
    sim = astar_path_custom(grid, start, goal, strength=strength, movement_mode=movement_mode, allow_tiles={WARP}, allow_warp_tiles=True)
    meta["passes"].append({"name": "sim_warp_tile", "found": sim is not None, "allow_tiles": [WARP]})
    if sim is not None:
        info = first_obstacle_on_route(grid, start, sim, {WARP}, strength=strength, movement_mode=movement_mode, goal=goal)
        if info:
            prev, obstacle, move_dir, tid = info
            stop = prev
            p_stop = astar_path_custom(grid, start, stop, strength=strength, movement_mode=movement_mode, allow_tiles=set(), allow_warp_tiles=False) or []
            meta["stop_reason"] = "Warp/teleporter blocking"
            meta["stop_tile"] = stop
            meta["blocking_tile"] = obstacle
            meta["blocking_tile_id"] = tid
            meta["facing"] = move_dir
            return p_stop, meta

    # --- 3) Proximity fallback (<=1 tile Manhattan) ---
    candidates: List[Coord] = []
    for dx, dy in [(0,0),(1,0),(-1,0),(0,1),(0,-1)]:
        c = (goal[0]+dx, goal[1]+dy)
        if not in_bounds(grid, c):
            continue
        if manhattan(c, goal) > 1:
            continue
        # reachable under strict rules (and must not be warp-like unless it is the goal itself)
        t = tile_at(grid, c)
        if c != goal and is_warp_like(t):
            continue
        if blocked_by_default(t, strength=strength, movement_mode=movement_mode):
            continue
        candidates.append(c)

    best: Optional[Tuple[int, Coord, Keys]] = None
    for c in candidates:
        k = astar_path_custom(grid, start, c, strength=strength, movement_mode=movement_mode, allow_tiles=set(), allow_warp_tiles=False)
        if k is None:
            continue
        score = (len(k), c)  # prefer fewer steps
        if best is None or score < (best[0], best[1]):
            best = (len(k), c, k)

    if best is not None:
        meta["fallback"] = {"type": "within_1", "chosen": best[1], "dist": manhattan(best[1], goal)}
        return best[2], meta

    # --- 4) No route ---
    meta["no_route"] = True
    return [], meta


if __name__ == "__main__":
    # Minimal CLI-style example
    import sys
    if len(sys.argv) >= 6:
        grid_path = sys.argv[1]
        sx, sy, gx, gy = map(int, sys.argv[2:6])
        keys, meta = plan_path(grid_path, (sx, sy), (gx, gy), strength=False, movement_mode="WALK")
        print(keys)
        print(meta)
