/**
 * A flavor with no photograph, drawn as one.
 *
 * Every tile on the register is the same size whether or not anybody has
 * photographed that flavor yet, so an empty square would be a hole in a grid
 * of pictures -- and worse, several unphotographed flavors of one product
 * would be several identical holes, which is exactly the moment a cashier
 * grabs the wrong box. Setting the name in a colour of its own makes it a
 * thing to aim at instead.
 *
 * The colour comes from the name, so a flavor keeps the same one everywhere it
 * appears and across reloads. The hue is the only thing that varies:
 * saturation and lightness are fixed, which is what keeps forty of these in a
 * grid looking like one designed set rather than a bag of sweets.
 */
export function FlavorTile({ name, className = "" }: { name: string; className?: string }) {
  const hue = hueFor(name);
  return (
    <div
      className={`flex h-full w-full items-center justify-center overflow-hidden p-1 text-center ${className}`}
      style={{ backgroundColor: `hsl(${hue} 45% 22%)`, color: `hsl(${hue} 70% 88%)` }}
      aria-hidden
    >
      <span className="line-clamp-3 text-[0.6rem] font-medium leading-tight">{name}</span>
    </div>
  );
}

/**
 * A stable hue for a name.
 *
 * FNV-1a rather than a sum of char codes: "Blue Razz" and "Razz Blue" are
 * different flavors and should not land on the same colour, which any
 * order-insensitive hash would give them.
 */
export function hueFor(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % 360;
}
