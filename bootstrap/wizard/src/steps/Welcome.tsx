interface Props {
  onNext: () => void;
}

export default function Welcome({ onNext }: Props) {
  return (
    <div className="bg-gray-900/60 border border-gray-800 rounded-2xl p-8">
      <div className="flex flex-col items-center mb-8">
        <img src="/OpenNova.png" alt="OpenNova" className="h-24 w-auto mb-4" />
        <h2 className="text-2xl font-bold text-white mb-2 text-center">Welkom bij OpenNova Bootstrap</h2>
        <p className="text-gray-400 leading-relaxed text-center">
          Deze wizard helpt je om de OpenNova firmware op je robotmaaier te flashen.
          Na afloop draait je maaier een eigen server en app — volledig offline.
        </p>
      </div>

      <div className="space-y-3 mb-8">
        <div className="flex items-start gap-3 p-4 bg-gray-800/50 rounded-xl">
          <span className="text-emerald-400 mt-0.5">&#9312;</span>
          <div>
            <p className="text-white font-medium">Firmware uploaden</p>
            <p className="text-gray-400 text-sm">Upload het OpenNova firmware-bestand (.deb)</p>
          </div>
        </div>
        <div className="flex items-start gap-3 p-4 bg-gray-800/50 rounded-xl">
          <span className="text-emerald-400 mt-0.5">&#9313;</span>
          <div>
            <p className="text-white font-medium">Netwerk instellen</p>
            <p className="text-gray-400 text-sm">Selecteer het netwerk waarop de maaier is aangesloten</p>
          </div>
        </div>
        <div className="flex items-start gap-3 p-4 bg-gray-800/50 rounded-xl">
          <span className="text-emerald-400 mt-0.5">&#9314;</span>
          <div>
            <p className="text-white font-medium">Docker server starten</p>
            <p className="text-gray-400 text-sm">Download en start de OpenNova Docker container</p>
          </div>
        </div>
        <div className="flex items-start gap-3 p-4 bg-gray-800/50 rounded-xl">
          <span className="text-emerald-400 mt-0.5">&#9315;</span>
          <div>
            <p className="text-white font-medium">Maaier flashen</p>
            <p className="text-gray-400 text-sm">Verbind de maaier met WiFi en start de OTA update via MQTT</p>
          </div>
        </div>
      </div>

      <div className="p-4 bg-amber-900/30 border border-amber-700/50 rounded-xl mb-8">
        <div className="flex items-start gap-2">
          <span className="text-amber-400 mt-0.5">&#9888;</span>
          <div className="text-sm text-amber-300">
            <p className="font-medium mb-1">Vereisten</p>
            <ul className="space-y-1 text-amber-400">
              <li>&#8226; Docker Desktop is geinstalleerd (of wordt in stap 3 begeleid)</li>
              <li>&#8226; Je maaier is aangezet en verbonden met hetzelfde WiFi-netwerk als deze computer</li>
              <li>&#8226; Je hebt de Novabot app gebruikt om de maaier aan het WiFi toe te voegen</li>
              <li>&#8226; Het OpenNova firmware-bestand (<code className="text-amber-300">novabot-v*-server.deb</code>)</li>
            </ul>
          </div>
        </div>
      </div>

      <button
        onClick={onNext}
        className="w-full py-3 px-6 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors"
      >
        Begin &rarr;
      </button>
    </div>
  );
}
