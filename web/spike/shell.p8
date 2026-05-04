pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
-- abc2p8 shell cart.
-- The web playground patches __sfx__ at 0x3200 and __music__ at 0x3100 at
-- runtime. This Lua just plays whatever lands in pattern 0 and lets us
-- re-trigger via btn(4) (z key). Keep it tiny.

playing = false

function _init()
 music(0)
 playing = true
end

function _update60()
 if btnp(4) then
  music(-1)
  music(0)
  playing = true
 end
 if btnp(5) then
  music(-1)
  playing = false
 end
end

function _draw()
 cls(1)
 print("abc2p8", 2, 2, 7)
 print(playing and "playing" or "stopped", 2, 10, 6)
 print("z = play  x = stop", 2, 120, 5)
end
__sfx__
013c08002405000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000
__music__
04 00414243

