"use client";

import { CircleMarker, MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";
import { useEffect } from "react";

type Point = { latitude: number; longitude: number };
type Coordinates = Point | null;

const AMMAN: [number, number] = [31.9539, 35.9106];

function MapClick({ onPick }: { onPick: (coordinates: Point) => void }) {
  useMapEvents({
    click(event) {
      onPick({ latitude: event.latlng.lat, longitude: event.latlng.lng });
    }
  });
  return null;
}

function MapCenter({ latitude, longitude }: Point) {
  const map = useMap();
  useEffect(() => {
    map.setView([latitude, longitude], Math.max(map.getZoom(), 15));
  }, [latitude, longitude, map]);
  return null;
}

export default function LocationPicker({ value, onChange }: { value: Coordinates; onChange: (coordinates: Point) => void }) {
  const center: [number, number] = value ? [value.latitude, value.longitude] : AMMAN;
  return (
    <MapContainer center={center} zoom={value ? 15 : 11} scrollWheelZoom={false} className="location-map">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {value && <MapCenter latitude={value.latitude} longitude={value.longitude} />}
      <MapClick onPick={onChange} />
      {value && <CircleMarker center={center} radius={10} pathOptions={{ color: "#0c1424", weight: 3, fillColor: "#f7b500", fillOpacity: 1 }} />}
    </MapContainer>
  );
}
