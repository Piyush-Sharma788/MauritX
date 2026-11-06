import {
  ArrowLeft,
  ArrowRight,
  BellOff,
  Building2,
  Check,
  Droplet,
  ExternalLink,
  Handshake,
  Info,
  LockKeyhole,
  MapPin,
  Menu,
  MessageCircle,
  Phone,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  TriangleAlert,
  X,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

/*
 * The app's icon set, backed by Lucide. Names are kept from the original
 * hand-drawn set so every call site keeps working. Decorative by default:
 * pass aria-label (and aria-hidden={false}) when an icon carries meaning alone.
 */
type IconProps = LucideProps;

const decorative = (Icon: LucideIcon) => {
  const Wrapped = (props: IconProps) => <Icon aria-hidden="true" strokeWidth={2} {...props} />;
  Wrapped.displayName = `${Icon.displayName ?? "Lucide"}Icon`;
  return Wrapped;
};

export const DropIcon = decorative(Droplet);
export const ShieldIcon = decorative(ShieldCheck);
export const HandshakeIcon = decorative(Handshake);
export const LockIcon = decorative(LockKeyhole);
export const ChatIcon = decorative(MessageCircle);
export const StethoscopeIcon = decorative(Stethoscope);
export const BuildingIcon = decorative(Building2);
export const MapPinIcon = decorative(MapPin);
export const PhoneIcon = decorative(Phone);
export const ArrowRightIcon = decorative(ArrowRight);
export const ArrowLeftIcon = decorative(ArrowLeft);
export const ExternalIcon = decorative(ExternalLink);
export const CheckIcon = decorative(Check);
export const XIcon = decorative(X);
export const MenuIcon = decorative(Menu);
export const AlertIcon = decorative(TriangleAlert);
export const InfoIcon = decorative(Info);
export const BellOffIcon = decorative(BellOff);
export const SparkIcon = decorative(Sparkles);
