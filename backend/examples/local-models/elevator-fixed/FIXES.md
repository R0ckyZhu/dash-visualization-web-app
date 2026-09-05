# Elevator model: original source, annotated with fixes

Original: `backend/examples/2022-tamjid-thesis/elevator/elevator.dsh`
Fixed version: `elevator-fixed.dsh` (this folder).

Background: in the generated Alloy, a transition constrains only what its
`do` block writes. The translation adds frames for everything else, but they
are weak: **set-image equalities** (`PID.(v') = PID.(v)`) for parameterized
variables in Elevator transitions — preserving which *values* are in use, not
*who* has them — and **no frames at all** for elevator variables in Controller
transitions. Any variable a transition leaves unwritten can therefore be
re-assigned by the solver ("drift"): elevators moved without Move transitions,
directions flipped, and pending calls hopped between elevators.

Fix classes:
- **FIX 1** — every Elevator transition writes all of the acting elevator's
  variables (`current'`, `direction'`, `called'`); unchanged ones get `x' = x`.
- **FIX 2** — `MovingUp/Idle` had an *unprimed* `do` equation (a source-state
  test placed in the post), leaving `current'` completely free.
- **FIX 3** — Controller dispatch transitions frame every elevator's
  `current'`/`direction'` via a new `FrameElevators` predicate.

Below is the **original** model with the fixes marked as `// FIX` comments at
each affected site.

```dash
open util/ordering[Floor]

sig Floor {}
abstract sig Direction {}
one sig Up, Down extends Direction {}

pred between [n1, nb, n2: Floor] {
	     lt[n1,n2] =>   ( lt[n1,nb] && lt[nb,n2] )
             else ( lt[n1,nb] || lt[nb,n2] )  }

state System {
	conc Controller {
		callToSend: Floor -> Direction

		default state Sending {}

		// FIX 3 (addition): the Controller's transitions constrain NO elevator
		// position or direction — their generated posts never mention
		// Elevator current'/direction', so a dispatch step may relocate every
		// elevator and flip every direction. The fixed model adds:
		//
		//     pred FrameElevators {
		//         all e: PID | {
		//             Elevator[e]/current' = Elevator[e]/current
		//             Elevator[e]/direction' = Elevator[e]/direction
		//         }
		//     }
		//
		// (per-atom quantification — the strong form; note the original
		// author already uses exactly this idiom for called' below.)

		pred SendUpRequest {
			one e0: PID, f: callToSend.Up | {
				Elevator[e0]/direction = Up
				lte[Elevator[e0]/current, f]
				Elevator[e0]/called' = Elevator[e0]/called + f
				callToSend' = callToSend - (f -> Up)
				no e1: PID - e0 | { Elevator[e1]/direction = Up and
					between[Elevator[e0]/current, Elevator[e1]/current, f] }
				// NOTE: per-atom cross-instance framing of called' — the same
				// pattern FIX 3 extends to current'/direction'.
				all others: PID - e0 | Elevator[others]/called' = Elevator[others]/called
			}
		}

		pred SendDownRequest {
			one e0: PID, f: callToSend.Down | {
				Elevator[e0]/direction = Down
				gte[Elevator[e0]/current, f]
				Elevator[e0]/called' = Elevator[e0]/called + f
				callToSend' = callToSend - (f -> Down)
				no e1: PID - e0 | Elevator[e1]/direction = Down and between[f, Elevator[e0]/current, Elevator[e1]/current]
				all others: PID - e0 | Elevator[others]/called' = Elevator[others]/called
			}
		}

		pred SendRequest {
			one e0: PID, f: callToSend.Direction | {
				Elevator[e0]/called' = Elevator[e0]/called + f
				callToSend' = callToSend - (f -> f.callToSend)
				all others: PID - e0 | Elevator[others]/called' = Elevator[others]/called
			}
		}

		trans SendingUpRequest {
			from Sending
			when Up in Floor.callToSend
			do {
				(some p: PID, f: callToSend.Up | lte[Elevator[p]/current, f] and Elevator[p]/direction = Up) => {
					SendUpRequest
				} else {
					SendRequest
				}
				// FIX 3: fixed model conjoins FrameElevators here
			}
			goto Sending
		}

		trans SendingDownRequest {
			from Sending
			when Down in Floor.callToSend
			do {
				(some p: PID, f: callToSend.Down | lte[f, Elevator[p]/current] and Elevator[p]/direction = Down) => {
					SendDownRequest
				} else {
					SendRequest
				}
				// FIX 3: fixed model conjoins FrameElevators here
			}
			goto Sending
		}

		init {
			#callToSend = 3
			Up !in Floor.callToSend
		}
	}

	conc Elevator [PID] {
		direction: one Direction
		called: set Floor
	 	current: one Floor

	       state MovingUp {
		 	trans MoveUp {
		        	when {
		            		some called
		            		direction = Up
		            		some nexts[current] & called
			    		current !in called
		        	}
		        	do {
		            		current' = min[(nexts[current] & called)]
		            		called' = called - current'
		            		// FIX 1: direction' unwritten — own direction only
		            		// union-framed, so directions could swap between
		            		// elevators. Fixed model adds: direction' = direction
		        	}
		   	 }

			trans ElevatorInCalled {
				when {
					some called
					called in current
				}
				do {
					called' = called - current
					// FIX 1: current' unwritten and only others-framed —
					// the ACTING elevator's position was completely free.
					// Fixed model adds: current' = current
					//                   direction' = direction
				}
			}

			trans ChangeDirToDown {
		        	when {
		            		some called
					no nexts[current] & called
					some prevs[current] & called
					current !in called
		        	}
				do {
					direction' = Down
					// FIX 1: fixed model adds: current' = current
					//                          called' = called
				}
				goto MovingDown
			}

		 	trans Idle {
				when {
		            		no called
		        	}
				do {
					current = min[Floor]
					// FIX 2: the line above is UNPRIMED — it is a test on the
					// source state that ends up in the generated post, while
					// current' is never written: the elevator may land on ANY
					// floor when going idle (observed teleports). It also
					// splits "enabled" from "firable": __trans_enabled checks
					// only the pre, but this condition lives in the post.
					// Fixed model replaces it with:
					//     current' = current
					//     direction' = direction
					//     called' = called
					// (parking at ground is Idle/DefaultToGround's job)
				}
				goto Idle
	         	}
	    }

	    state MovingDown {
		 	trans MoveDown {
		        	when {
		            		some called
		            		direction = Down
		            		some prevs[current] & called
			    		current !in called
		        	}
		        	do {
		            		current' = max[(prevs[current] & called)]
		            		called' = called - current'
		            		// FIX 1: adds direction' = direction
		        	}
		   	 }

			trans ElevatorInCalled {
				when {
					some called
					called in current
				}
				do {
					called' = called - current
					// FIX 1: adds current' = current, direction' = direction
				}
			}

			trans ChangeDirToUp {
		        	when {
		            		some called
					no prevs[current] & called
					some nexts[current] & called
					current !in called
		        	}
				do {
					direction' = Up
					// FIX 1: adds current' = current, called' = called
				}
				goto MovingUp
			}

		 	trans Idle {
				when {
		            		no called
		        	}
				// FIX 1: NO do-block at all — current', direction', called'
				// all solver-chosen (up to weak union frames). Fixed model
				// adds a do-block with all three x' = x.
				goto Idle
	         	}
	    }

	    default state Idle {
		 	trans DefaultToGround {
		        	when {
		            		no called
		            		min[Floor] not in current
		        	}
		        	do current' = min[Floor]
		        	// FIX 1: adds direction' = direction, called' = called
		    	}

		 	trans Move {
		        	when {
		            		some called
		        	}
		        	// FIX 1: NO do-block — everything free. Fixed model adds
		        	// all three x' = x.
		        	goto MovingUp
		    	}
		}
		init {
			no called
			current = min[Floor]
			direction = Up
		}
	}


}
```

## Residual limitation (not fixable in the model)

The translation's cross-instance frames remain set-image equalities, so with
**3+ elevators** the non-acting elevators can still permute values among
themselves during another region's step (union preserved, ownership shuffled).
With 2 elevators, the explicit per-atom updates above make traces fully
drift-free (verified: `current` changes only on `MoveUp`/`MoveDown`/
`DefaultToGround`, `direction` only on `ChangeDir*`). The principled fix is
upstream: per-atom auto-framing of unmentioned instance variables in the
frame generation (`TransPostD2A`).
