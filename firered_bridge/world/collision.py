from __future__ import annotations

from typing import Any, Dict, List

from ..constants.addresses import (
    MAPGRID_COLLISION_MASK,
    MAPGRID_ELEVATION_MASK,
    MAPGRID_METATILE_ID_MASK,
    MAPGRID_UNDEFINED,
)
from ..constants import behaviors as behavior_consts
from ..constants.behaviors import (
    CRACKED_FLOOR_BEHAVIOR_IDS,
    CRACKED_ICE_BEHAVIOR_IDS,
    DIRECTIONAL_IMPASSABLE_BEHAVIOR_ID_TO_TILE,
    DIVEABLE_WATER_BEHAVIOR_IDS,
    FORCED_MOVEMENT_ARROW_BEHAVIOR_ID_TO_TILE,
    GRASS_BEHAVIOR_IDS,
    LEDGE_BEHAVIOR_ID_TO_TILE,
    RED_CARPET_BEHAVIOR_IDS,
    SPINNER_BEHAVIOR_ID_TO_TILE,
    STRENGTH_SWITCH_BEHAVIOR_ID_TO_TILE,
    SURFABLE_WATER_BEHAVIOR_IDS,
    THIN_ICE_BEHAVIOR_IDS,
    WATER_CURRENT_BEHAVIOR_ID_TO_TILE,
    _init_behavior_id_tables,
)
from ..constants.tiles import (
    BASE_TILE_PASSABILITY,
    MINIMAP_CODE_FREE_GROUND,
    MINIMAP_CODE_WALL,
    TILE_BLOCKED,
    TILE_CRACKED_FLOOR,
    TILE_CRACKED_ICE,
    TILE_DIVE_WATER,
    TILE_GRASS,
    TILE_RED_CARPET,
    TILE_STRENGTH_SWITCH,
    TILE_THIN_ICE,
    TILE_WALKABLE,
    TILE_WATER,
    TILE_WATERFALL,
    minimap_code_for_tile,
)

# Collision/passability algorithm
# =============================================================================


def process_tiles_to_collision_map(
    tile_values: List[int],
    width: int,
    behaviors: List[int],
    player_elev: int,
    player_surf: bool,
    secondary_tileset: int = 0,  # kept for compatibility, but no longer used (red carpet handled by behavior only)
    *,
    include_map_data: bool = True,
) -> Dict[str, Any]:
    """
    Processes tile data to generate a passability map.

    Primarily uses mapgrid collision bits (bits 10-11).
    Behaviors are used for ledges / waterfall / tags (grass/water/red carpet).
    """
    if width <= 0:
        return {
            "width": 0,
            "height": 0,
            "tile_passability": BASE_TILE_PASSABILITY,
            "map_data": [],
            "minimap_data": {"grid": []},
        }

    if behaviors:
        _init_behavior_id_tables()

    num_tiles = len(tile_values)
    height = (num_tiles + width - 1) // width
    total_cells = width * height

    # 1st pass: collect raw info (flat arrays, no per-tile dict)
    present = [False] * total_cells
    collision_bits_arr = [0] * total_cells
    elev_arr = [0] * total_cells
    is_undef_arr = [False] * total_cells
    is_transition_arr = [False] * total_cells
    beh_id_arr = [-1] * total_cells

    limit = min(num_tiles, total_cells)
    for i in range(limit):
        val = tile_values[i]
        present[i] = True

        collision_bits = (val & MAPGRID_COLLISION_MASK) >> 10
        elev = (val & MAPGRID_ELEVATION_MASK) >> 12
        metatile_id = val & MAPGRID_METATILE_ID_MASK

        # Bridges => elev 15 = keep player elevation
        if elev == 15:
            elev = player_elev

        collision_bits_arr[i] = collision_bits
        elev_arr[i] = elev
        is_undef_arr[i] = val == MAPGRID_UNDEFINED
        is_transition_arr[i] = elev == 0

        if behaviors and metatile_id < len(behaviors):
            beh_id_arr[i] = behaviors[metatile_id]

    # 2nd pass: passability determination
    out_rows: List[List[str]] = []
    minimap_grid: List[List[int]] = []

    for y in range(height):
        r: Optional[List[str]] = [] if include_map_data else None
        r_codes: List[int] = []
        for x in range(width):
            i = y * width + x
            if i < 0 or i >= total_cells or (not present[i]):
                if include_map_data:
                    assert r is not None
                    r.append(f"{x},{y}:{TILE_BLOCKED}")
                r_codes.append(MINIMAP_CODE_WALL)
                continue

            tile_type = TILE_BLOCKED
            beh_id = beh_id_arr[i]
            coll = collision_bits_arr[i]
            elev = elev_arr[i]

            # Priority 1: Undefined tile = blocked
            if is_undef_arr[i]:
                tile_type = TILE_BLOCKED
            # Priority 2: Special behaviors (ledges / waterfall)
            # NOTE: Some special tiles (e.g. ledges) have a non-zero collision flag in the mapgrid,
            # which is normal because you cannot "stand" on them. Their semantics come from the behavior.
            elif beh_id in LEDGE_BEHAVIOR_ID_TO_TILE:
                tile_type = LEDGE_BEHAVIOR_ID_TO_TILE[beh_id]
            elif beh_id != -1 and beh_id == behavior_consts.WATERFALL_BEHAVIOR_ID:
                tile_type = TILE_WATERFALL
            # Priority 3: Explicit collision (bits 10-11 != 0) = blocked
            elif coll != 0:
                tile_type = TILE_BLOCKED
            # Priority 5: Elevation-based passability
            elif is_transition_arr[i]:
                tile_type = TILE_WALKABLE
            elif player_elev == 0:
                tile_type = TILE_WALKABLE
            elif elev == player_elev:
                tile_type = TILE_WALKABLE
            elif elev == 3 and player_surf:
                tile_type = TILE_WALKABLE
            else:
                adj_same_elev = False
                # N
                if y > 0:
                    ni = i - width
                    if present[ni] and (elev_arr[ni] == player_elev) and (collision_bits_arr[ni] == 0):
                        adj_same_elev = True
                # S
                if (not adj_same_elev) and (y + 1) < height:
                    ni = i + width
                    if ni < total_cells and present[ni] and (elev_arr[ni] == player_elev) and (collision_bits_arr[ni] == 0):
                        adj_same_elev = True
                # W
                if (not adj_same_elev) and x > 0:
                    ni = i - 1
                    if present[ni] and (elev_arr[ni] == player_elev) and (collision_bits_arr[ni] == 0):
                        adj_same_elev = True
                # E
                if (not adj_same_elev) and (x + 1) < width:
                    ni = i + 1
                    if ni < total_cells and present[ni] and (elev_arr[ni] == player_elev) and (collision_bits_arr[ni] == 0):
                        adj_same_elev = True
                tile_type = TILE_BLOCKED if adj_same_elev else TILE_WALKABLE

            # Extra classification for special walkable tiles
            # IMPORTANT: some terrain types are better identified via behavior than via our
            # elevation/collision heuristics (e.g. shoreline water should not become "Wall").
            # IMPORTANT: do not overwrite explicit collision with a terrain tag.
            # Some water tiles (e.g. invisible sea barriers) have an "OCEAN_WATER" behavior
            # but a non-zero collision flag: they are impassable in-game and must stay "Wall".
            if coll == 0 and beh_id in WATER_CURRENT_BEHAVIOR_ID_TO_TILE:
                tile_type = WATER_CURRENT_BEHAVIOR_ID_TO_TILE[beh_id]
            elif coll == 0 and beh_id in DIVEABLE_WATER_BEHAVIOR_IDS:
                tile_type = TILE_DIVE_WATER
            elif coll == 0 and beh_id in SURFABLE_WATER_BEHAVIOR_IDS:
                tile_type = TILE_WATER
            elif tile_type == TILE_WALKABLE and beh_id in DIRECTIONAL_IMPASSABLE_BEHAVIOR_ID_TO_TILE:
                tile_type = DIRECTIONAL_IMPASSABLE_BEHAVIOR_ID_TO_TILE[beh_id]
            elif tile_type == TILE_WALKABLE and beh_id in GRASS_BEHAVIOR_IDS:
                tile_type = TILE_GRASS
            elif tile_type == TILE_WALKABLE and beh_id in RED_CARPET_BEHAVIOR_IDS:
                tile_type = TILE_RED_CARPET
            elif tile_type == TILE_WALKABLE and beh_id in STRENGTH_SWITCH_BEHAVIOR_ID_TO_TILE:
                tile_type = TILE_STRENGTH_SWITCH
            elif tile_type == TILE_WALKABLE and beh_id in SPINNER_BEHAVIOR_ID_TO_TILE:
                tile_type = SPINNER_BEHAVIOR_ID_TO_TILE[beh_id]
            elif tile_type == TILE_WALKABLE and beh_id in FORCED_MOVEMENT_ARROW_BEHAVIOR_ID_TO_TILE:
                tile_type = FORCED_MOVEMENT_ARROW_BEHAVIOR_ID_TO_TILE[beh_id]
            elif tile_type == TILE_WALKABLE and beh_id in THIN_ICE_BEHAVIOR_IDS:
                tile_type = TILE_THIN_ICE
            elif tile_type == TILE_WALKABLE and beh_id in CRACKED_ICE_BEHAVIOR_IDS:
                tile_type = TILE_CRACKED_ICE
            elif tile_type == TILE_WALKABLE and beh_id in CRACKED_FLOOR_BEHAVIOR_IDS:
                tile_type = TILE_CRACKED_FLOOR

            code = minimap_code_for_tile(tile_type, default_code=MINIMAP_CODE_FREE_GROUND)

            if include_map_data:
                assert r is not None
                r.append(f"{x},{y}:{tile_type}")
            r_codes.append(code)

        if include_map_data:
            assert r is not None
            out_rows.append(r)
        minimap_grid.append(r_codes)

    return {
        "width": width,
        "height": height,
        "tile_passability": BASE_TILE_PASSABILITY,
        "map_data": out_rows if include_map_data else [],
        "minimap_data": {"grid": minimap_grid},
    }


# =============================================================================
