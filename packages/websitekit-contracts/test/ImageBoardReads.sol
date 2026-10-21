// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ImageBoard } from "../src/ImageBoard.sol";
import { ImageBoardStorage } from "../src/ImageBoardStorage.sol";

/// @notice Four reads the board no longer carries (2026-10-20: dropped to make room for rentals under
/// EIP-170), rebuilt here from the reads it keeps, so the suites ask what they always asked. Each is
/// a plain composition: `buyError`/`quoteBlocks` of one rectangle, the grid's two getters, and a row's
/// occupancy from `cellRow`.
library ImageBoardReads {
    function gridSize(ImageBoard b) internal view returns (uint16, uint16) {
        return (b.gridCols(), b.gridRows());
    }

    function blockError(ImageBoard b, uint16 col, uint16 row, uint16 cols, uint16 rows) internal view returns (bytes4) {
        return b.buyError(_one(col, row, cols, rows));
    }

    function quote(ImageBoard b, uint16 col, uint16 row, uint16 cols, uint16 rows) internal view returns (uint256) {
        return b.quoteBlocks(_one(col, row, cols, rows));
    }

    function rowBits(ImageBoard b, uint256 row) internal view returns (uint256 bits) {
        uint256[] memory words = b.cellRow(row);
        uint256 cols = b.gridCols();
        for (uint256 c = 0; c < cols; c++) {
            if ((words[c / 8] >> ((c % 8) * 32)) & type(uint32).max != 0) bits |= uint256(1) << c;
        }
    }

    function _one(uint16 col, uint16 row, uint16 cols, uint16 rows) private pure returns (ImageBoardStorage.Rect[] memory r) {
        r = new ImageBoardStorage.Rect[](1);
        r[0] = ImageBoardStorage.Rect(col, row, cols, rows);
    }
}
