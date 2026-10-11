# Tablescore

A personal board game scoring app. Games are scored with a weighted rubric and compared against BoardGameGeek ratings.

## Language

### Scoring

**Tablescore**:
The final score for a game: 5 + (weighted average of the rubric criteria − 5) × stretch, clamped to 0–10, one decimal.
_Avoid_: rating (that word is reserved for BGG ratings)

**Status**:
Where a game sits in the user's BGG collection (Owned, Preordered, Prev. owned, Wishlist, Want to play). It belongs to BGG and a sync overwrites it.
_Avoid_: using it for anything the app decides

### Watchlist

**Watchlist**:
The crowdfunded games the user is following but not backing, waiting for delivery and reviews before deciding whether to buy a used copy.

**Watching**:
A game is Watching when it has a watch stage. It is independent of its status: a watched game is often Wishlist on BGG.
_Avoid_: Watching status

**Watch stage**:
How far a watched game has progressed: Campaign live → Awaiting delivery → Delivered → Reviews out → Buy or Pass.

**Decided**:
A watched game whose stage is Buy or Pass. It stays on the watchlist for reference, but nothing checks on it any more.

**Predicted score**:
A Tablescore estimated from reviews, for a game the user hasn't played. It is kept apart from real rubric scores and is always labeled as predicted.
_Avoid_: projected score, expected score

**Target price**:
The most the user wants to pay for a used copy, with its currency.
_Avoid_: max price, budget
